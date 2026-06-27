const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// === CONFIG ===
// Replace these with your actual values
const token = process.env.TOKEN;
const LOG_CHANNEL_ID = '1520333813794738246';
const CLIENT_ID = '1513576938118189257';

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
        .addUserOption(opt => opt.setName('target').setDescription('User to check').setRequired(false))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(token);
(async () => {
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Commands registered');
    } catch (err) { console.error(err); }
})();

// === HELPER FUNCTIONS ===
function ensureUserRow(userId) {
    db.run('INSERT OR IGNORE INTO status_tracker (userId) VALUES (?)', [userId]);
}

function startStatus(userId, status) {
    ensureUserRow(userId);
    db.run('UPDATE status_tracker SET lastStatus = ?, statusStart = ? WHERE userId = ?', [status, Date.now(), userId]);
}

function endStatus(userId, callback) {
    db.get('SELECT lastStatus, statusStart FROM status_tracker WHERE userId = ?', [userId], (err, row) => {
        if (err || !row || !row.statusStart || !row.lastStatus) return;
        const duration = Math.floor((Date.now() - row.statusStart) / 1000);
        const col = row.lastStatus + 'Seconds';
        db.run(`UPDATE status_tracker SET ${col} = ${col} + ?, statusStart = ?, lastStatus = ? WHERE userId = ?`,
            [duration, Date.now(), row.lastStatus, userId], () => { if (callback) callback(duration, row.lastStatus); });
    });
}

// === EVENT HANDLERS ===
client.on('messageCreate', msg => {
    if (msg.author.bot) return;
    ensureUserRow(msg.author.id);
    db.run('UPDATE status_tracker SET messages = messages + 1 WHERE userId = ?', [msg.author.id]);
});

client.on('voiceStateUpdate', (oldState, newState) => {
    const userId = newState.id;
    ensureUserRow(userId);
    db.get('SELECT voiceStart, voiceSeconds FROM status_tracker WHERE userId = ?', [userId], (err, row) => {
        if (!row) return;
        if (!oldState.channel && newState.channel) {
            db.run('UPDATE status_tracker SET voiceStart = ? WHERE userId = ?', [Date.now(), userId]);
        }
        if (oldState.channel && !newState.channel && row.voiceStart) {
            const duration = Math.floor((Date.now() - row.voiceStart) / 1000);
            const totalVoice = (row.voiceSeconds || 0) + duration;
            db.run('UPDATE status_tracker SET voiceSeconds = ?, voiceStart = NULL WHERE userId = ?', [totalVoice, userId]);
        }
    });
});

client.on('presenceUpdate', (oldPresence, newPresence) => {
    if (!newPresence || !newPresence.guild) return;
    const userId = newPresence.user.id;
    ensureUserRow(userId);

    const oldStatus = oldPresence?.status;
    const newStatus = newPresence.status;
    if (oldStatus === newStatus) return;

    endStatus(userId, (duration, prevStatus) => {
        const logChannel = newPresence.guild.channels.cache.get(LOG_CHANNEL_ID);
        if (!logChannel) return;

        const embed = new EmbedBuilder()
            .setTitle('Status Changed')
            .setDescription(`${newPresence.user.tag} changed from **${prevStatus}** to **${newStatus}**`)
            .addFields({ name: 'Time in previous status', value: `${duration} seconds`, inline: true })
            .setColor('Blue')
            .setTimestamp();

        logChannel.send({ embeds: [embed] });
        startStatus(userId, newStatus);
    });
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'statusstats') return;

    const target = interaction.options.getUser('target') || interaction.user;
    ensureUserRow(target.id);

    db.get('SELECT * FROM status_tracker WHERE userId = ?', [target.id], (err, row) => {
        if (err || !row) return interaction.reply(`${target.tag} has no recorded activity.`);

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
    });
});

client.on('ready', async () => {
    client.guilds.cache.forEach(guild => {
        guild.members.fetch().then(members => {
            members.forEach(member => {
                const status = member.presence?.status || 'offline';
                ensureUserRow(member.id);
                startStatus(member.id, status);
            });
        });
    });
    console.log(`Logged in as ${client.user.tag}`);
});

client.login(token);
