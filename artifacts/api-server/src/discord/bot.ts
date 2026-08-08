import {
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Guild,
  GuildMember,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  guildSettingsTable,
  warningsTable,
  walletsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";

const log = logger.child({ service: "discord-bot" });
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const OWNER_ID = process.env.BOT_OWNER_ID;
const DAILY_SALARY = 2_500;
const TASK_REWARD = 500;
const MAX_DAILY_TASKS = 3;

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildModeration,
];

if (process.env.DISCORD_ENABLE_PRIVILEGED_INTENTS === "true") {
  intents.push(GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent);
}

const client = new Client({ intents });

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function getWallet(guildId: string, userId: string) {
  await db
    .insert(walletsTable)
    .values({ guildId, userId, tasksDate: today() })
    .onConflictDoNothing({
      target: [walletsTable.guildId, walletsTable.userId],
    });
  const [wallet] = await db
    .select()
    .from(walletsTable)
    .where(
      and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)),
    )
    .limit(1);
  if (!wallet) throw new Error("Wallet could not be created.");
  return wallet;
}

async function getSettings(guildId: string) {
  await db
    .insert(guildSettingsTable)
    .values({ guildId })
    .onConflictDoNothing({ target: guildSettingsTable.guildId });
  const [settings] = await db
    .select()
    .from(guildSettingsTable)
    .where(eq(guildSettingsTable.guildId, guildId))
    .limit(1);
  if (!settings) throw new Error("Guild settings could not be created.");
  return settings;
}

async function addMoney(guildId: string, userId: string, amount: number) {
  await getWallet(guildId, userId);
  const [wallet] = await db
    .update(walletsTable)
    .set({
      balance: sql`${walletsTable.balance} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)),
    )
    .returning();
  return wallet;
}

async function setMoney(guildId: string, userId: string, amount: number) {
  await getWallet(guildId, userId);
  const [wallet] = await db
    .update(walletsTable)
    .set({ balance: amount, updatedAt: new Date() })
    .where(
      and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)),
    )
    .returning();
  return wallet;
}

async function sendLog(guild: Guild, title: string, description: string) {
  try {
    const settings = await getSettings(guild.id);
    if (!settings.logChannelId) return;
    const channel = await guild.channels.fetch(settings.logChannelId);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(description.slice(0, 4000))
      .setColor(0x5865f2)
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (error) {
    log.warn({ err: error, guildId: guild.id }, "Could not send audit log");
  }
}

function memberName(member: GuildMember | { user: { tag: string; id: string } }) {
  return `${member.user.tag} (${member.user.id})`;
}

function replyText(
  interaction: {
    reply: (options: { content: string; ephemeral?: boolean }) => Promise<unknown>;
  },
  content: string,
  ephemeral = false,
) {
  return interaction.reply({ content, ephemeral });
}

function isOwner(userId: string) {
  return Boolean(
    OWNER_ID === userId || client.application?.owner?.id === userId,
  );
}

const commandBuilders = [
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("عرض رصيدك أو رصيد عضو آخر")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو المطلوب").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("pay")
    .setDescription("تحويل عملة B إلى عضو آخر")
    .addUserOption((option) =>
      option.setName("user").setDescription("المستلم").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("مقدار التحويل")
        .setMinValue(1)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("salary")
    .setDescription("استلام راتب يومي مقداره 2500 B"),
  new SlashCommandBuilder()
    .setName("task")
    .setDescription("تنفيذ مهمة يومية، كل مهمة تكافئك بـ 500 B")
    .addStringOption((option) =>
      option
        .setName("sentence")
        .setDescription("اكتب جملة من اختيارك لتنفيذ المهمة")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("تحذير عضو بسبب مخالفة")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("سبب التحذير").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("unwarn")
    .setDescription("إزالة آخر تحذير عن عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("عرض تحذيرات عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("set-log")
    .setDescription("تحديد روم سجل الأحداث")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("روم السجل")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("set-welcome")
    .setDescription("تفعيل رسالة الترحيب في روم محدد")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("روم الترحيب")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription("النص، استخدم {user} لمنشن العضو")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("alias")
    .setDescription("إنشاء اسم بديل لأمر سلاش")
    .addStringOption((option) =>
      option
        .setName("command")
        .setDescription("الأمر الإنجليزي مثل balance")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("الاسم البديل مثل ب")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("autoreply")
    .setDescription("إضافة رد تلقائي عند كتابة كلمة")
    .addStringOption((option) =>
      option.setName("trigger").setDescription("الكلمة").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reply").setDescription("الرد").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("grant")
    .setDescription("منح عضوًا رصيدًا — لمالك البوت فقط")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName("amount").setDescription("المبلغ").setMinValue(1).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("reset-balance")
    .setDescription("تصفير رصيد عضو — لمالك البوت فقط")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("طرد عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("السبب").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("حظر عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("السبب").setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("مسح عدد من الرسائل")
    .addIntegerOption((option) =>
      option.setName("amount").setDescription("العدد من 1 إلى 100").setMinValue(1).setMaxValue(100).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("nickname")
    .setDescription("تغيير اسم عضو")
    .addUserOption((option) =>
      option.setName("user").setDescription("العضو").setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("name").setDescription("الاسم الجديد").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("create-role")
    .setDescription("صنع رتبة جديدة")
    .addStringOption((option) =>
      option.setName("name").setDescription("اسم الرتبة").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("create-channel")
    .setDescription("صنع روم نصي جديد")
    .addStringOption((option) =>
      option.setName("name").setDescription("اسم الروم").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("hide-channel")
    .setDescription("إخفاء الروم عن الأعضاء")
    .addChannelOption((option) =>
      option.setName("channel").setDescription("الروم").addChannelTypes(ChannelType.GuildText).setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("show-channel")
    .setDescription("إظهار الروم للأعضاء")
    .addChannelOption((option) =>
      option.setName("channel").setDescription("الروم").addChannelTypes(ChannelType.GuildText).setRequired(true),
    ),
].map((command) => command.toJSON());

async function handleInteraction(
  interaction: Parameters<typeof client.on>[1] extends never ? never : any,
): Promise<unknown> {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;
  const guild = interaction.guild;
  const command = interaction.commandName;
  const userId = interaction.user.id;

  try {
    if (command === "balance") {
      const target = interaction.options.getUser("user") ?? interaction.user;
      const wallet = await getWallet(guild.id, target.id);
      return replyText(interaction, `رصيد **${target.tag}** هو **${wallet.balance.toLocaleString()} B**.`);
    }

    if (command === "pay") {
      const target = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      if (target.bot || target.id === userId) return replyText(interaction, "لا يمكن التحويل إلى بوت أو إلى نفسك.", true);
      const sender = await getWallet(guild.id, userId);
      if (sender.balance < amount) return replyText(interaction, "رصيدك غير كافٍ.", true);
      await addMoney(guild.id, userId, -amount);
      const receiver = await addMoney(guild.id, target.id, amount);
      return replyText(interaction, `تم تحويل **${amount.toLocaleString()} B** إلى ${target}. رصيدك الآن **${(receiver ? sender.balance - amount : 0).toLocaleString()} B**.`);
    }

    if (command === "salary") {
      const wallet = await getWallet(guild.id, userId);
      if (wallet.lastSalaryAt && Date.now() - wallet.lastSalaryAt.getTime() < 86_400_000) {
        const hours = Math.ceil((86_400_000 - (Date.now() - wallet.lastSalaryAt.getTime())) / 3_600_000);
        return replyText(interaction, `استلمت راتبك مسبقًا. حاول بعد **${hours} ساعة**.`, true);
      }
      await db.update(walletsTable).set({ balance: sql`${walletsTable.balance} + ${DAILY_SALARY}`, lastSalaryAt: new Date(), updatedAt: new Date() }).where(eq(walletsTable.id, wallet.id));
      return replyText(interaction, `تم إيداع راتبك اليومي: **${DAILY_SALARY.toLocaleString()} B**.`);
    }

    if (command === "task") {
      const wallet = await getWallet(guild.id, userId);
      const completed = wallet.tasksDate === today() ? wallet.tasksCompleted : 0;
      if (completed >= MAX_DAILY_TASKS) return replyText(interaction, "أنجزت مهام اليوم الثلاث. عد غدًا.", true);
      await db.update(walletsTable).set({
        balance: sql`${walletsTable.balance} + ${TASK_REWARD}`,
        tasksDate: today(),
        tasksCompleted: completed + 1,
        updatedAt: new Date(),
      }).where(eq(walletsTable.id, wallet.id));
      return replyText(interaction, `مهمة مكتملة (**${interaction.options.getString("sentence", true)}**). حصلت على **${TASK_REWARD} B** — أنجزت ${completed + 1}/${MAX_DAILY_TASKS} اليوم.`);
    }

    if (command === "warn") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) return replyText(interaction, "تحتاج صلاحية Moderate Members.", true);
      const target = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason", true);
      await db.insert(warningsTable).values({ guildId: guild.id, userId: target.id, moderatorId: userId, reason });
      await sendLog(guild, "تحذير عضو", `${target} تم تحذيره بواسطة ${interaction.user}.\nالسبب: ${reason}`);
      return replyText(interaction, `تم تحذير ${target}.\nالسبب: ${reason}`);
    }

    if (command === "unwarn" || command === "warnings") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) return replyText(interaction, "تحتاج صلاحية Moderate Members.", true);
      const target = interaction.options.getUser("user", true);
      const rows = await db.select().from(warningsTable).where(and(eq(warningsTable.guildId, guild.id), eq(warningsTable.userId, target.id))).orderBy(desc(warningsTable.createdAt));
      if (command === "unwarn") {
        const last = rows[0];
        if (!last) return replyText(interaction, "لا توجد تحذيرات لهذا العضو.", true);
        await db.delete(warningsTable).where(eq(warningsTable.id, last.id));
        await sendLog(guild, "إزالة تحذير", `تمت إزالة آخر تحذير عن ${target} بواسطة ${interaction.user}.`);
        return replyText(interaction, `تمت إزالة آخر تحذير عن ${target}.`);
      }
      if (!rows.length) return replyText(interaction, `لا توجد تحذيرات على ${target}.`);
      return replyText(interaction, `تحذيرات ${target}:\n${rows.slice(0, 10).map((row, index) => `${index + 1}. ${row.reason}`).join("\n")}`);
    }

    if (command === "set-log") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return replyText(interaction, "تحتاج صلاحية Manage Server.", true);
      const channel = interaction.options.getChannel("channel", true);
      await db.update(guildSettingsTable).set({ logChannelId: channel.id, updatedAt: new Date() }).where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(interaction, `تم تحديد ${channel} كسجل للأحداث.`);
    }

    if (command === "set-welcome") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return replyText(interaction, "تحتاج صلاحية Manage Server.", true);
      const channel = interaction.options.getChannel("channel", true);
      const message = interaction.options.getString("message") ?? "أهلًا {user}، نورت السيرفر.";
      await db.update(guildSettingsTable).set({ welcomeChannelId: channel.id, welcomeMessage: message, updatedAt: new Date() }).where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(interaction, `تم تفعيل الترحيب في ${channel}. استخدم {user} لمنشن العضو.`);
    }

    if (command === "alias" || command === "autoreply") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return replyText(interaction, "تحتاج صلاحية Manage Server.", true);
      const settings = await getSettings(guild.id);
      const key = command === "alias" ? interaction.options.getString("command", true) : interaction.options.getString("trigger", true);
      const value = command === "alias" ? interaction.options.getString("name", true) : interaction.options.getString("reply", true);
      const current = command === "alias" ? { ...settings.aliases, [value]: key } : { ...settings.autoReplies, [key]: value };
      await db.update(guildSettingsTable).set({ [command === "alias" ? "aliases" : "autoReplies"]: current, updatedAt: new Date() }).where(eq(guildSettingsTable.guildId, guild.id));
      return replyText(interaction, command === "alias" ? `تم ربط **${value}** بالأمر **/${key}**. يمكنك كتابة ${value} @عضو في الشات.` : `تمت إضافة الرد التلقائي للكلمة **${key}**.`);
    }

    if (command === "grant" || command === "reset-balance") {
      if (!isOwner(userId)) return replyText(interaction, "هذا الأمر متاح لمالك البوت فقط.", true);
      const target = interaction.options.getUser("user", true);
      if (command === "grant") {
        const amount = interaction.options.getInteger("amount", true);
        await addMoney(guild.id, target.id, amount);
        return replyText(interaction, `تم منح ${target} مبلغ **${amount.toLocaleString()} B**.`);
      }
      await setMoney(guild.id, target.id, 0);
      return replyText(interaction, `تم تصفير رصيد ${target}.`);
    }

    const memberTarget = interaction.options.getMember("user");
    if (command === "kick" || command === "ban") {
      const needed = command === "ban" ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.KickMembers;
      if (!interaction.memberPermissions?.has(needed)) return replyText(interaction, `تحتاج صلاحية ${command === "ban" ? "Ban Members" : "Kick Members"}.`, true);
      if (!memberTarget || !("kick" in memberTarget || "ban" in memberTarget)) return replyText(interaction, "لم أجد العضو داخل السيرفر.", true);
      const reason = interaction.options.getString("reason") ?? "بدون سبب";
      if (command === "ban") await (memberTarget as GuildMember).ban({ reason });
      else await (memberTarget as GuildMember).kick(reason);
      await sendLog(guild, command === "ban" ? "حظر عضو" : "طرد عضو", `${memberTarget} بواسطة ${interaction.user}.\nالسبب: ${reason}`);
      return replyText(interaction, `تم ${command === "ban" ? "حظر" : "طرد"} العضو بنجاح.`);
    }

    if (command === "clear") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) return replyText(interaction, "تحتاج صلاحية Manage Messages.", true);
      const channel = interaction.channel;
      const amount = interaction.options.getInteger("amount", true);
      if (!channel || !("bulkDelete" in channel)) return replyText(interaction, "هذا الأمر يعمل في الرومات النصية فقط.", true);
      await (channel as TextChannel).bulkDelete(amount, true);
      return replyText(interaction, `تم مسح ${amount} رسالة.`, true);
    }

    if (command === "nickname") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageNicknames)) return replyText(interaction, "تحتاج صلاحية Manage Nicknames.", true);
      if (!memberTarget || !("setNickname" in memberTarget)) return replyText(interaction, "لم أجد العضو.", true);
      await (memberTarget as GuildMember).setNickname(interaction.options.getString("name", true));
      return replyText(interaction, "تم تغيير اسم العضو.");
    }

    if (command === "create-role") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) return replyText(interaction, "تحتاج صلاحية Manage Roles.", true);
      const role = await guild.roles.create({ name: interaction.options.getString("name", true), reason: `بواسطة ${interaction.user.tag}` });
      return replyText(interaction, `تم صنع الرتبة ${role}.`);
    }

    if (command === "create-channel") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) return replyText(interaction, "تحتاج صلاحية Manage Channels.", true);
      const channel = await guild.channels.create({ name: interaction.options.getString("name", true), type: ChannelType.GuildText });
      return replyText(interaction, `تم صنع الروم ${channel}.`);
    }

    if (command === "hide-channel" || command === "show-channel") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) return replyText(interaction, "تحتاج صلاحية Manage Channels.", true);
      const channel = interaction.options.getChannel("channel", true);
      if (!("permissionOverwrites" in channel)) return replyText(interaction, "اختر رومًا نصيًا.", true);
      await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: command === "show-channel" });
      return replyText(interaction, `تم ${command === "show-channel" ? "إظهار" : "إخفاء"} الروم.`);
    }
    return undefined;
  } catch (error) {
    log.error({ err: error, guildId: guild.id, command }, "Discord command failed");
    if (interaction.replied || interaction.deferred) await interaction.editReply("حدث خطأ غير متوقع أثناء تنفيذ الأمر.");
    else await replyText(interaction, "حدث خطأ غير متوقع أثناء تنفيذ الأمر.", true);
    return undefined;
  }
}

async function handleMessage(message: Parameters<typeof client.on>[1] extends never ? never : any) {
  if (!message.guild || message.author.bot) return;
  const content = message.content.trim();
  const settings = await getSettings(message.guild.id);
  const lower = content.toLowerCase();
  const autoReply = Object.entries(settings.autoReplies).find(([trigger]) => lower.includes(trigger.toLowerCase()));
  if (autoReply) await message.reply(autoReply[1]);

  const parts = content.split(/\s+/);
  const alias = settings.aliases[parts[0]] ?? settings.aliases[parts[0]?.toLowerCase()];
  if (!alias) return;
  if (alias === "balance" || alias === "salary" || alias === "task" || alias === "pay") {
    if (alias === "balance") {
      const target = message.mentions.users.first() ?? message.author;
      const wallet = await getWallet(message.guild.id, target.id);
      await message.reply(`رصيدك هو **${wallet.balance.toLocaleString()} B**.`);
    } else if (alias === "salary") {
      await message.reply("استخدم أمر السلاش **/salary** لاستلام راتبك.");
    } else if (alias === "pay" && message.mentions.users.first()) {
      const target = message.mentions.users.first();
      const amount = Number(parts.find((part: string) => /^\d+$/.test(part)));
      if (!amount || amount < 1) {
        await message.reply("اكتب المبلغ بعد المنشن، مثال: `تحويل @عضو 500`.");
        return;
      }
      const sender = await getWallet(message.guild.id, message.author.id);
      if (sender.balance < amount) {
        await message.reply("رصيدك غير كافٍ.");
        return;
      }
      await addMoney(message.guild.id, message.author.id, -amount);
      await addMoney(message.guild.id, target.id, amount);
      await message.reply(`تم تحويل **${amount.toLocaleString()} B** إلى ${target}.`);
    } else {
      await message.reply(`استخدم أمر السلاش **/${alias}** لإكمال العملية.`);
    }
    return;
  }

  if (alias === "warn" && message.mentions.users.first()) {
    if (!message.member?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await message.reply("تحتاج صلاحية Moderate Members.");
      return;
    }
    const target = message.mentions.users.first();
    const reason = parts.slice(2).filter((part: string) => !part.startsWith("<@")).join(" ") || "بدون سبب";
    await db.insert(warningsTable).values({
      guildId: message.guild.id,
      userId: target.id,
      moderatorId: message.author.id,
      reason,
    });
    await sendLog(message.guild, "تحذير عضو", `${target} تم تحذيره بواسطة ${message.author}.\nالسبب: ${reason}`);
    await message.reply(`تم تحذير ${target}.\nالسبب: ${reason}`);
    return;
  }

  if ((alias === "ban" || alias === "kick") && message.mentions.members.first()) {
    const permission = alias === "ban" ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.KickMembers;
    if (!message.member?.permissions.has(permission)) {
      await message.reply(`تحتاج صلاحية ${alias === "ban" ? "Ban Members" : "Kick Members"}.`);
      return;
    }
    const target = message.mentions.members.first();
    const reason = parts.slice(2).filter((part: string) => !part.startsWith("<@")).join(" ") || "بدون سبب";
    if (alias === "ban") await target.ban({ reason });
    else await target.kick(reason);
    await sendLog(message.guild, alias === "ban" ? "حظر عضو" : "طرد عضو", `${target} بواسطة ${message.author}.\nالسبب: ${reason}`);
    await message.reply(`تم ${alias === "ban" ? "حظر" : "طرد"} ${target}.`);
  }
}

function registerEvents() {
  client.on("interactionCreate", (interaction) => void handleInteraction(interaction));
  client.on("messageCreate", (message) => void handleMessage(message));
  client.on("guildMemberAdd", async (member) => {
    const settings = await getSettings(member.guild.id);
    if (settings.welcomeChannelId) {
      const channel = await member.guild.channels.fetch(settings.welcomeChannelId);
      if (channel?.isTextBased()) await channel.send((settings.welcomeMessage ?? "أهلًا {user}").replaceAll("{user}", `${member}`));
    }
    await sendLog(member.guild, "عضو دخل السيرفر", `${memberName(member)}`);
  });
  client.on("guildMemberRemove", (member) => void sendLog(member.guild, "عضو خرج من السيرفر", `${memberName(member)}`));
  client.on("messageDelete", (message) => {
    if (message.guild) void sendLog(message.guild, "حذف رسالة", `في ${message.channel} بواسطة ${message.author?.tag ?? "عضو غير معروف"}:\n${message.content || "محتوى غير متاح"}`);
  });
  client.on("messageUpdate", (oldMessage, newMessage) => {
    if (newMessage.guild && oldMessage.content !== newMessage.content) void sendLog(newMessage.guild, "تعديل رسالة", `في ${newMessage.channel}:\nقبل: ${oldMessage.content || "غير متاح"}\nبعد: ${newMessage.content || "غير متاح"}`);
  });
  client.on("channelCreate", (channel) => void sendLog(channel.guild, "صنع روم", `${channel}`));
  client.on("channelDelete", (channel) => {
    if ("guild" in channel && channel.guild) {
      void sendLog(channel.guild, "حذف روم", `#${"name" in channel ? channel.name : "روم"}`);
    }
  });
  client.on("channelUpdate", (oldChannel, newChannel) => {
    if ("guild" in newChannel && newChannel.guild && "name" in oldChannel && "name" in newChannel) {
      void sendLog(newChannel.guild, "تعديل روم", `#${oldChannel.name} ← #${newChannel.name}`);
    }
  });
  client.on("roleCreate", (role) => void sendLog(role.guild, "صنع رتبة", `${role}`));
  client.on("roleDelete", (role) => void sendLog(role.guild, "حذف رتبة", `@${role.name}`));
  client.on("roleUpdate", (oldRole, newRole) => void sendLog(newRole.guild, "تعديل رتبة", `@${oldRole.name} ← @${newRole.name}`));
  client.on("guildMemberUpdate", (oldMember, newMember) => {
    if (oldMember.nickname !== newMember.nickname) void sendLog(newMember.guild, "تغيير اسم شخص", `${memberName(newMember)}: ${oldMember.nickname ?? oldMember.user.username} ← ${newMember.nickname ?? newMember.user.username}`);
  });
  client.on("guildUpdate", (oldGuild, newGuild) => void sendLog(newGuild, "تغيير معلومات السيرفر", `${oldGuild.name} ← ${newGuild.name}`));
  client.on("guildAuditLogEntryCreate", async (entry, guild) => {
    const actions = new Map<number, string>([
      [AuditLogEvent.MemberKick, "طرد شخص"],
      [AuditLogEvent.MemberBanAdd, "حظر شخص"],
      [AuditLogEvent.MemberRoleUpdate, "تغيير رتبة عضو"],
      [AuditLogEvent.MessageDelete, "مسح رسالة"],
      [AuditLogEvent.ChannelOverwriteCreate, "إخفاء/فتح روم"],
    ]);
    const title = actions.get(entry.action);
    if (title) await sendLog(guild, title, `بواسطة ${entry.executor?.tag ?? "غير معروف"}`);
  });
}

export async function startDiscordBot() {
  if (!BOT_TOKEN) {
    log.warn("DISCORD_BOT_TOKEN is not set; Discord bot is disabled");
    return;
  }
  if (process.env.DISCORD_ENABLE_PRIVILEGED_INTENTS !== "true") {
    log.warn(
      "Privileged Discord intents are disabled; slash commands work, but welcome, auto-replies, and message-content logging require DISCORD_ENABLE_PRIVILEGED_INTENTS=true and Developer Portal approval",
    );
  }
  registerEvents();
  client.once("clientReady", async (readyClient) => {
    try {
      const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
      await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commandBuilders });
      log.info({ tag: readyClient.user.tag, commands: commandBuilders.length }, "Discord bot connected and commands registered");
    } catch (error) {
      log.error({ err: error }, "Could not register Discord slash commands");
    }
  });
  await client.login(BOT_TOKEN);
}