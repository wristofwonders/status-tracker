const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    REST,
    Routes,
    SlashCommandBuilder
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// === CONFIG ===
const token = process.env.TOKEN;
const LOG_CHANNEL_ID = '1510333813794738246';
const CLIENT_ID = '1513576938118189257';
const ACCEPT_ROLE_ID = '1513576678486573258';
const ACCEPT_ANNOUNCE_CHANNEL_ID = '1513632041277587658';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ]
});

// === DATABASE SETUP ===
const dbPath = path.resolve(__dirname, 'status.db');
const db = new sqlite3.Database(dbPath);

db.run(`
CREATE TABLE IF NOT EXISTS status_tracker (
    userId TEXT PRIMARY KEY,
    onlineSeconds INTEGER DEFAULT 0,
    idleSeconds INTEGER DEFAULT 0,
    dndSeconds INTEGER DEFAULT 0,
    offlineSeconds INTEGER DEFAULT 0,
    messages INTEGER DEFAULT 0,
    voiceSeconds INTEGER DEFAULT 0,
    statusStart INTEGER,
    lastStatus TEXT,
    voiceStart INTEGER
)
`);

// === SLASH COMMANDS ===
const commands = [
    new SlashCommandBuilder()
        .setName('statusstats')
        .setDescription('Shows total status stats for a user')
        .addUserOption(opt =>
            opt.setName('target')
               .setDescription('User to check')
               .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('say')
        .setDescription('Make the bot say something')
        .addStringOption(opt =>
            opt.setName('text')
               .setDescription('Text to say')
               .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('accept')
        .setDescription('Accept a player and give them the role')
        .addUserOption(opt =>
            opt.setName('user')
               .setDescription('User to accept')
               .setRequired(true)
        )
        .addIntegerOption(opt =>
            opt.setName('level')
               .setDescription('Player level')
               .setRequired(true)
        )
        .addIntegerOption(opt =>
            opt.setName('winrate')
               .setDescription('Player winrate (0-100)')
               .setRequired(true)
        )
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(token);
(async () => {
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Commands registered');
    } catch (err) {
        console.error(err);
    }
})();

// === HELPER FUNCTIONS ===
function ensureUserRow(userId) {
    db.run('INSERT OR IGNORE INTO status_tracker (userId) VALUES (?)', [userId]);
}

function startStatus(userId, status) {
    ensureUserRow(userId);
    db.run(
        'UPDATE status_tracker SET lastStatus = ?, statusStart = ? WHERE userId = ?',
        [status, Date.now(), userId]
    );
}

function endStatus(userId, callback) {
    db.get(
        'SELECT lastStatus, statusStart FROM status_tracker WHERE userId = ?',
        [userId],
        (err, row) => {
            if (err || !row || !row.statusStart || !row.lastStatus) return;
            const duration = Math.floor((Date.now() - row.statusStart) / 1000);
            const col = row.lastStatus + 'Seconds';
            db.run(
                `UPDATE status_tracker SET ${col} = ${col} + ?, statusStart = ?, lastStatus = ? WHERE userId = ?`,
                [duration, Date.now(), row.lastStatus, userId],
                () => {
                    if (callback) callback(duration, row.lastStatus);
                }
            );
        }
    );
}

// === MESSAGE HANDLER ===
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;

    // Track messages
    ensureUserRow(msg.author.id);
    db.run('UPDATE status_tracker SET messages = messages + 1 WHERE userId = ?', [msg.author.id]);

    // Auto reply when bot is mentioned
    if (msg.mentions.has(client.user)) {
        const onlineCount = msg.guild.members.cache.filter(
            m => m.presence?.status === 'online'
        ).size;
        const time = new Date().toLocaleTimeString();

        msg.reply(
            `Hello, how are you?\n` +
            `Time: **${time}**\n` +
            `People online: **${onlineCount}**`
        );
    }
});

// === VOICE HANDLER ===
client.on('voiceStateUpdate', (oldState, newState) => {
    const userId = newState.id;
    ensureUserRow(userId);
    db.get(
        'SELECT voiceStart, voiceSeconds FROM status_tracker WHERE userId = ?',
        [userId],
        (err, row) => {
            if (!row) return;

            // Joined voice
            if (!oldState.channel && newState.channel) {
                db.run('UPDATE status_tracker SET voiceStart = ? WHERE userId = ?', [
                    Date.now(),
                    userId
                ]);
            }

            // Left voice
            if (oldState.channel && !newState.channel && row.voiceStart) {
                const duration = Math.floor((Date.now() - row.voiceStart) / 1000);
                const totalVoice = (row.voiceSeconds || 0) + duration;
                db.run(
                    'UPDATE status_tracker SET voiceSeconds = ?, voiceStart = NULL WHERE userId = ?',
                    [totalVoice, userId]
                );
            }
        }
    );
});

// === PRESENCE HANDLER ===
client.on('presenceUpdate', (oldPresence, newPresence) => {
    if (!newPresence || !newPresence.guild) return;
    const userId = newPresence.user.id;
    ensureUserRow(userId);

    const oldStatus = oldPresence?.status;
    const newStatus = newPresence.status;
    if (oldStatus === newStatus) return;

    endStatus(userId, (duration, prevStatus) => {
        const logChannel = newPresence.guild.channels.cache.get(LOG_CHANNEL_ID);
        if (!logChannel) {
            startStatus(userId, newStatus);
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('Status Changed')
            .setDescription(
                `${newPresence.user.tag} changed from **${prevStatus}** to **${newStatus}**`
            )
            .addFields({
                name: 'Time in previous status',
                value: `${duration} seconds`,
                inline: true
            })
            .setColor('Blue')
            .setTimestamp();

        logChannel.send({ embeds: [embed] });
        startStatus(userId, newStatus);
    });
});

// === INTERACTION HANDLER ===
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // /statusstats
    if (interaction.commandName === 'statusstats') {
        const target = interaction.options.getUser('target') || interaction.user;
        ensureUserRow(target.id);

        db.get(
            'SELECT * FROM status_tracker WHERE userId = ?',
            [target.id],
            (err, row) => {
                if (err || !row)
                    return interaction.reply(`${target.tag} has no recorded activity.`);

                const embed = new EmbedBuilder()
                    .setTitle(`Status Stats for ${target.tag}`)
                    .addFields(
                        { name: 'Online Time', value: `${row.onlineSeconds}s`, inline: true },
                        { name: 'Idle Time', value: `${row.idleSeconds}s`, inline: true },
                        { name: 'DND Time', value: `${row.dndSeconds}s`, inline: true },
                        { name: 'Offline Time', value: `${row.offlineSeconds}s`, inline: true },
                        { name: 'Messages Sent', value: `${row.messages}`, inline: true },
                        { name: 'Voice Time', value: `${row.voiceSeconds}s`, inline: true }
                    )
                    .setColor('Green')
                    .setTimestamp();

                interaction.reply({ embeds: [embed] });
            }
        );
    }

    // /say
    if (interaction.commandName === 'say') {
        const text = interaction.options.getString('text');
        await interaction.reply({ content: 'Message sent!', ephemeral: true });
        interaction.channel.send(text);
    }

    // /accept
    if (interaction.commandName === 'accept') {
        const user = interaction.options.getUser('user');
        const level = interaction.options.getInteger('level');
        const winrate = interaction.options.getInteger('winrate');

        const member = await interaction.guild.members.fetch(user.id);

        await member.roles.add(ACCEPT_ROLE_ID);

        let extra = '';
        if (level > 200) extra += ' (high lvl)';
        if (winrate > 70) extra += ' (high wr)';

        const announceChannel = interaction.guild.channels.cache.get(
            ACCEPT_ANNOUNCE_CHANNEL_ID
        );

        if (announceChannel) {
            announceChannel.send(
                `Welcome To House of Keys Clan!\n` +
                `We would appreciate it if you add **HK_** before your Roblox Username.\n` +
                `**TAKE THE TAG**\n\n` +
                `${user} ${extra}`
            );
        }

        interaction.reply(`${user.tag} has been accepted and given the role.`);
    }
});

// === READY HANDLER ===
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    client.guilds.cache.forEach(guild => {
        guild.members.fetch().then(members => {
            members.forEach(member => {
                const status = member.presence?.status || 'offline';
                ensureUserRow(member.id);
                startStatus(member.id, status);
            });
        });
    });
});

client.login(token);
