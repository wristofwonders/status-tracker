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
const CLIENT_ID = '1513576938118189257';
const LOG_CHANNEL_ID = '1510333813794738246';
const ACCEPT_ROLE_ID = '1513576678486573258';
const ACCEPT_ANNOUNCE_CHANNEL_ID = '1513632041277587658';

// === CLIENT ===
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// === DATABASE ===
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
            if (!row || !row.statusStart) return;

            const duration = Math.floor((Date.now() - row.statusStart) / 1000);
            const col = row.lastStatus + 'Seconds';

            db.run(
                `UPDATE status_tracker SET ${col} = ${col} + ?, statusStart = ?, lastStatus = ? WHERE userId = ?`,
                [duration, Date.now(), row.lastStatus, userId],
                () => callback && callback(duration, row.lastStatus)
            );
        }
    );
}

// === COOLDOWN MAP ===
const rolePingCooldown = new Map();

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
               .setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('winrate')
               .setDescription('Player winrate (0-100)')
               .setRequired(false)
        ),

    // === NEW COMMAND: /roleping ===
    new SlashCommandBuilder()
        .setName('roleping')
        .setDescription('Ping a role')
        .addRoleOption(opt =>
            opt.setName('role')
               .setDescription('Role to ping')
               .setRequired(true)
        )
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(token);
(async () => {
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Commands registered');
    } catch (err) {
        console.error(err);
    }
})();

// === MESSAGE HANDLER ===
client.on('messageCreate', async msg => {
    if (msg.author.bot) return;

    ensureUserRow(msg.author.id);
    db.run('UPDATE status_tracker SET messages = messages + 1 WHERE userId = ?', [msg.author.id]);

    if (msg.mentions.has(client.user)) {
        const onlineCount = msg.guild.members.cache.filter(
            m => m.presence?.status === 'online'
        ).size;

        const timeIE = new Date().toLocaleString("en-IE", {
            timeZone: "Europe/Dublin",
            hour12: false
        });

        msg.reply(
            `Hello, how are you?\n` +
            `Time: **${timeIE}**\n` +
            `People online: **${onlineCount}**`
        );
    }
});

// === VOICE TRACKING ===
client.on('voiceStateUpdate', (oldState, newState) => {
    const userId = newState.id;
    ensureUserRow(userId);

    db.get(
        'SELECT voiceStart, voiceSeconds FROM status_tracker WHERE userId = ?',
        [userId],
        (err, row) => {
            if (!row) return;

            if (!oldState.channel && newState.channel) {
                db.run('UPDATE status_tracker SET voiceStart = ? WHERE userId = ?', [
                    Date.now(),
                    userId
                ]);
            }

            if (oldState.channel && !newState.channel && row.voiceStart) {
                const duration = Math.floor((Date.now() - row.voiceStart) / 1000);
                const total = (row.voiceSeconds || 0) + duration;

                db.run(
                    'UPDATE status_tracker SET voiceSeconds = ?, voiceStart = NULL WHERE userId = ?',
                    [total, userId]
                );
            }
        }
    );
});

// === PRESENCE TRACKING ===
client.on('presenceUpdate', (oldP, newP) => {
    if (!newP || !newP.guild) return;

    const userId = newP.user.id;
    ensureUserRow(userId);

    const oldStatus = oldP?.status;
    const newStatus = newP.status;

    if (oldStatus === newStatus) return;

    endStatus(userId, (duration, prevStatus) => {
        const logChannel = newP.guild.channels.cache.get(LOG_CHANNEL_ID);

        if (logChannel) {
            const embed = new EmbedBuilder()
                .setTitle('Status Changed')
                .setDescription(
                    `${newP.user.tag} changed from **${prevStatus}** to **${newStatus}**`
                )
                .addFields({
                    name: 'Time in previous status',
                    value: `${duration} seconds`,
                    inline: true
                })
                .setColor('Blue')
                .setTimestamp();

            logChannel.send({ embeds: [embed] });
        }

        startStatus(userId, newStatus);
    });
});

// === INTERACTIONS ===
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
                if (!row)
                    return interaction.reply(`${target.tag} has no recorded activity.`);

                const embed = new EmbedBuilder()
                    .setTitle(`Status Stats for ${target.tag}`)
                    .addFields(
                        { name: 'Online', value: `${row.onlineSeconds}s`, inline: true },
                        { name: 'Idle', value: `${row.idleSeconds}s`, inline: true },
                        { name: 'DND', value: `${row.dndSeconds}s`, inline: true },
                        { name: 'Offline', value: `${row.offlineSeconds}s`, inline: true },
                        { name: 'Messages', value: `${row.messages}`, inline: true },
                        { name: 'Voice', value: `${row.voiceSeconds}s`, inline: true }
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

        let tags = '';
        if (level !== null && level >= 200) tags += ' (high lvl)';
        if (winrate !== null && winrate >= 70) tags += ' (high wr)';

        const timeIE = new Date().toLocaleString("en-IE", {
            timeZone: "Europe/Dublin",
            hour12: false
        });

        const announceChannel = interaction.guild.channels.cache.get(
            ACCEPT_ANNOUNCE_CHANNEL_ID
        );

        if (announceChannel) {
            announceChannel.send(
                `${user} Welcome To **House of Keys Clan!**\n` +
                `We would appreciate it if you add **HK_** before your Roblox Username.\n` +
                `**TAKE THE TAG**\n\n` +
                `Time: **${timeIE}**\n` +
                `${tags}`
            );
        }

        interaction.reply(`${user.tag} has been accepted and given the role.`);
    }

    // === NEW COMMAND: /roleping ===
    if (interaction.commandName === 'roleping') {
        const role = interaction.options.getRole('role');
        const userId = interaction.user.id;

        const now = Date.now();
        const data = rolePingCooldown.get(userId) || { count: 0, lastPing: 0 };

        if (data.count >= 2) {
            const timePassed = now - data.lastPing;

            if (timePassed < 3 * 60 * 1000) {
                const remaining = Math.ceil((3 * 60 * 1000 - timePassed) / 1000);
                return interaction.reply({
                    content: `⏳ You must wait **${remaining} seconds** before pinging another role.`,
                    ephemeral: true
                });
            } else {
                data.count = 0;
            }
        }

        data.count++;
        data.lastPing = now;
        rolePingCooldown.set(userId, data);

        await interaction.reply({ content: 'Role ping sent!', ephemeral: true });

        interaction.channel.send(
            `${interaction.user} pinged ${role}`
        );
    }
});

// === READY ===
client.on('ready', () => {
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
