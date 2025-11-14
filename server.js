import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import bodyParser from "body-parser";
import { Server as SocketIOServer } from "socket.io";
import { Telegraf } from "telegraf";
import crypto from "crypto";

const USE_TOPICS = true;

const {
  BOT_TOKEN,
  ADMIN_GROUP_ID,
  PUBLIC_ORIGIN,
  REQUESTS_THREAD_ID,
  LOGS_THREAD_ID,
} = process.env;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}
if (!ADMIN_GROUP_ID) {
  console.error("❌ ADMIN_GROUP_ID is missing");
  process.exit(1);
}
if (!REQUESTS_THREAD_ID) {
  console.error("❌ REQUESTS_THREAD_ID is missing");
  process.exit(1);
}
if (!LOGS_THREAD_ID) {
  console.error("❌ LOGS_THREAD_ID is missing");
  process.exit(1);
}

const REQ_TID = Number(REQUESTS_THREAD_ID);
const LOGS_TID = Number(LOGS_THREAD_ID);

const app = express();
app.use(cors({ origin: "*" }));
app.use(bodyParser.json());
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const bot = new Telegraf(BOT_TOKEN);

// компактные логи апдейтов
bot.use(async (ctx, next) => {
  const info = {
    type: ctx.updateType,
    chatType: ctx.chat?.type,
    chatId: ctx.chat?.id,
    threadId: ctx.message?.message_thread_id || null,
    text: ctx.message?.text || ctx.message?.caption || "",
  };
  console.log("🆕 UPDATE:", info);
  return next();
});

// --- In-memory ---
const sessionToSocket = new Map();
const socketToSession = new Map();
const sessionMsgMeta = new Map();
const sessionToThreadId = new Map();
const threadIdToSession = new Map();

// --- Helpers ---
function chatIdToCLinkId(chatId) {
  return String(chatId).replace("-100", "");
}
function topicLink(chatId, threadId) {
  return `https://t.me/c/${chatIdToCLinkId(chatId)}/${threadId}`;
}
const REPLY_CLOSE_BTN = "❌ Закрыть заявку";

// создать (или вернуть) ветку диалога
async function ensureTopicForSession(sessionId) {
  if (!USE_TOPICS) return null;
  if (sessionToThreadId.has(sessionId)) return sessionToThreadId.get(sessionId);

  const name = `Session #${sessionId}`;
  let topic;
  try {
    topic = await bot.telegram.createForumTopic(ADMIN_GROUP_ID, name);
  } catch (e) {
    console.error(
      "❌ createForumTopic error:",
      e?.response?.description || e.message
    );
    throw new Error("Включите Темы и дайте боту право Manage Topics.");
  }

  // стартовое сообщение + reply-клавиатура
  const starter = await bot.telegram.sendMessage(
    ADMIN_GROUP_ID,
    `🔰 Открыта ветка для ${name}. ID: [#${sessionId}]`,
    {
      message_thread_id: topic.message_thread_id,
      reply_markup: {
        keyboard: [[{ text: REPLY_CLOSE_BTN }]],
        resize_keyboard: true,
      },
    }
  );

  const threadId = starter.message_thread_id;
  sessionToThreadId.set(sessionId, threadId);
  threadIdToSession.set(threadId, sessionId);
  console.log("🧵 ensureTopicForSession OK", { sessionId, threadId });
  return threadId;
}

// закрытие сессии: логи → LOGS, уведомление в ветку, правим карточку, событие виджету
async function closeSession(sessionId, { cause = "admin", byUser } = {}) {
  const title =
    cause === "admin"
      ? `⛔️ Сессию #${sessionId} закрыл админ${
          byUser ? ` @${byUser.username || byUser.id}` : ""
        }`
      : `🔴 Пользователь покинул чат · Session #${sessionId}`;

  // 1) LOGS topic
  try {
    await bot.telegram.sendMessage(ADMIN_GROUP_ID, title, {
      message_thread_id: LOGS_TID,
    });
  } catch (e) {
    console.error("log->logs error:", e?.response?.description || e.message);
  }

  // 2) ветка диалога
  const threadId = sessionToThreadId.get(sessionId);
  if (threadId) {
    try {
      await bot.telegram.sendMessage(
        ADMIN_GROUP_ID,
        cause === "admin"
          ? `⛔️ Диалог #${sessionId} завершён админом`
          : `🔴 Пользователь покинул чат #${sessionId}`,
        { message_thread_id: threadId }
      );
      await bot.telegram.sendMessage(ADMIN_GROUP_ID, "Диалог закрыт.", {
        message_thread_id: threadId,
        reply_markup: { remove_keyboard: true },
      });
    } catch (e) {
      console.error(
        "close->thread error:",
        e?.response?.description || e.message
      );
    }
  }

  // 3) карточку в REQUESTS помечаем
  try {
    const meta = sessionMsgMeta.get(sessionId);
    if (meta) {
      await bot.telegram.editMessageText(
        meta.chatId,
        meta.messageId,
        undefined,
        cause === "admin"
          ? `❌ Диалог #${sessionId} закрыт админом.`
          : `❌ Диалог #${sessionId} закрыт клиентом.`
      );
    }
  } catch (e) {
    console.error("edit card error:", e?.response?.description || e.message);
  }

  // 4) событие виджету
  try {
    const socketId = sessionToSocket.get(sessionId);
    if (socketId) io.to(socketId).emit("session_closed", { cause });
  } catch {}

  // 5) отвязываем сокет
  sessionToSocket.delete(sessionId);
}

// карточка в REQUESTS + запись в LOGS + дубль первого сообщения в ветку
async function postCardToRequests(sessionId, text) {
  const threadId = await ensureTopicForSession(sessionId);
  const link = topicLink(ADMIN_GROUP_ID, threadId);

  const msgText = [
    "🆘 Новый запрос поддержки",
    `Session: #${sessionId}`,
    "",
    "Сообщение:",
    text,
  ].join("\n");

  const keyboard = {
    inline_keyboard: [
      [
        { text: "🔗 Перейти в ветку", url: link },
        { text: "❌ Закрыть заявку", callback_data: `close:${sessionId}` },
      ],
    ],
  };

  // Карточка в REQUESTS
  const sent = await bot.telegram.sendMessage(ADMIN_GROUP_ID, msgText, {
    reply_markup: keyboard,
    message_thread_id: REQ_TID,
  });
  sessionMsgMeta.set(sessionId, {
    chatId: sent.chat.id,
    messageId: sent.message_id,
  });
  console.log("📨 Карточка в REQUESTS", { sessionId, msgId: sent.message_id });

  // Лог в LOGS (создано)
  try {
    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      `🟢 Создан диалог · Session #${sessionId}`,
      { message_thread_id: LOGS_TID }
    );
  } catch (e) {
    console.error(
      "log create -> logs error:",
      e?.response?.description || e.message
    );
  }

  // Дублируем первое сообщение клиента в ветку диалога
  const short = String(sessionId).slice(0, 8);
  try {
    await bot.telegram.sendMessage(
      ADMIN_GROUP_ID,
      `👤 Клиент [#${sessionId}] (${short}):\n${text}`,
      { message_thread_id: threadId }
    );
  } catch (e) {
    console.error(
      "duplicate to thread failed:",
      e?.response?.description || e.message
    );
  }
}

// Socket.IO (виджет)
io.on("connection", (socket) => {
  socket.on("hello", (clientSessionId) => {
    const sessionId = clientSessionId || crypto.randomBytes(8).toString("hex");
    sessionToSocket.set(sessionId, socket.id);
    socketToSession.set(socket.id, sessionId);
    socket.emit("session", sessionId);
  });

  socket.on("client_message", async ({ text }) => {
    try {
      const sid = socketToSession.get(socket.id);
      const clean = String(text || "").trim();
      if (!sid || !clean) return;

      console.log("🌐 client_message", { sid, clean });

      const hasCard = sessionMsgMeta.has(sid);
      const hasThread = sessionToThreadId.has(sid);

      // первое сообщение — карточка (REQUESTS) + лог (LOGS) + дубль в ветку
      if (!hasCard && !hasThread) {
        await postCardToRequests(sid, clean);
        socket.emit("server_ack", { ok: true });
        return;
      }

      // дальше — в ветку диалога
      const threadId = await ensureTopicForSession(sid);
      const short = String(sid).slice(0, 8);
      await bot.telegram.sendMessage(
        ADMIN_GROUP_ID,
        `👤 Клиент [#${sid}] (${short}):\n${clean}`,
        { message_thread_id: threadId }
      );

      socket.emit("server_ack", { ok: true });
    } catch (e) {
      console.error(
        "❌ client_message error:",
        e?.response?.description || e.message
      );
      socket.emit("server_ack", { ok: false, error: "send_failed" });
    }
  });

  socket.on("client_end", async (payload = {}) => {
    const sid = socketToSession.get(socket.id);
    if (!sid) return;
    console.log("👋 client_end", { sid, ...payload });

    try {
      await closeSession(sid, { cause: "client" });
    } catch {}
    socketToSession.delete(socket.id);
  });

  socket.on("disconnect", () => {
    const sid = socketToSession.get(socket.id);
    if (sid) sessionToSocket.delete(sid);
    socketToSession.delete(socket.id);
  });
});

// Inline кнопка на карточке (REQUESTS)
bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery?.data || "";
    await ctx.answerCbQuery();

    if (data.startsWith("close:")) {
      const sid = data.slice(6);
      if (!sid) return;
      await closeSession(sid, { cause: "admin", byUser: ctx.from });

      const meta = sessionMsgMeta.get(sid);
      if (meta) {
        try {
          await bot.telegram.editMessageText(
            meta.chatId,
            meta.messageId,
            undefined,
            `❌ Диалог #${sid} закрыт админом.`
          );
        } catch {}
      }

      // лог в LOGS
      try {
        await bot.telegram.sendMessage(
          ADMIN_GROUP_ID,
          `⛔️ Закрыто по карточке · Session #${sid}`,
          { message_thread_id: LOGS_TID }
        );
      } catch {}
      return;
    }
  } catch (e) {
    console.error("CBQ handler error:", e?.response?.description || e.message);
  }
});

// Админ -> Клиент из ветки диалога + reply-кнопка Закрыть заявку
bot.on("message", async (ctx) => {
  const dbg = {
    from: ctx.from?.username || ctx.from?.id,
    chatType: ctx.chat?.type,
    chatId: ctx.chat?.id,
    threadId: ctx.message?.message_thread_id || null,
    text: ctx.message?.text || ctx.message?.caption || "",
  };
  console.log("📥 RAW MESSAGE:", dbg);

  try {
    if (!["group", "supergroup"].includes(ctx.chat?.type)) return;
    if (ctx.from?.is_bot) return;

    const text = ctx.message.text || ctx.message.caption || "";
    const threadId = ctx.message.message_thread_id || null;

    // нажата reply-кнопка Закрыть заявку
    if (text === REPLY_CLOSE_BTN && threadId) {
      const sid = threadIdToSession.get(threadId);
      if (sid) {
        await closeSession(sid, { cause: "admin", byUser: ctx.from });
        await ctx.reply(`⛔️ Диалог #${sid} закрыт.`, {
          reply_markup: { remove_keyboard: true },
        });
        try {
          await bot.telegram.sendMessage(
            ADMIN_GROUP_ID,
            `⛔️ Закрыто из ветки · Session #${sid}`,
            { message_thread_id: LOGS_TID }
          );
        } catch {}
      }
      return;
    }

    // обычный ответ админа клиенту
    let sid = null;
    let replyText = text;

    if (threadId && threadIdToSession.size) {
      sid = threadIdToSession.get(threadId) || null;
    }
    if (!sid && text) {
      const m = text.match(/^#([a-f0-9]{6,32})\s+([\s\S]+)/i);
      if (m) {
        sid = m[1];
        replyText = m[2];
      }
    }
    if (!sid && ctx.message.reply_to_message?.text) {
      const rt = ctx.message.reply_to_message.text;
      const mr = rt.match(/#([a-f0-9]{6,32})/i);
      if (mr) {
        sid = mr[1];
        replyText = text;
      }
    }
    if (!sid || !replyText) return;

    const socketId = sessionToSocket.get(sid);
    if (!socketId) {
      console.log("⚠️  Клиент оффлайн для", sid);
      return;
    }

    io.to(socketId).emit("admin_message", { text: replyText, ts: Date.now() });
    console.log("➡️  ADMIN→WIDGET", {
      sid,
      replyText: String(replyText).slice(0, 80),
    });
  } catch (e) {
    console.error(
      "❌ admin->widget error:",
      e?.response?.description || e.message
    );
  }
});

// /close — закрыть из темы/реплаем
bot.command("close", async (ctx) => {
  try {
    if (!["group", "supergroup"].includes(ctx.chat?.type)) return;
    let sid = null;
    const threadId = ctx.message?.message_thread_id || null;

    if (threadId && threadIdToSession.size)
      sid = threadIdToSession.get(threadId) || null;
    if (!sid && ctx.message?.reply_to_message?.text) {
      const mr = ctx.message.reply_to_message.text.match(/#([a-f0-9]{6,32})/i);
      if (mr) sid = mr[1];
    }
    if (!sid)
      return ctx.reply(
        "Не нашёл sessionId. Запусти команду в теме или ответь реплаем на сообщение клиента."
      );

    await closeSession(sid, { cause: "admin", byUser: ctx.from });
    await ctx.reply(`⛔️ Диалог #${sid} закрыт.`, {
      reply_markup: { remove_keyboard: true },
    });
    try {
      await bot.telegram.sendMessage(
        ADMIN_GROUP_ID,
        `⛔️ Закрыто командой /close · Session #${sid}`,
        { message_thread_id: LOGS_TID }
      );
    } catch {}
  } catch (e) {
    console.error("/close error:", e?.response?.description || e.message);
  }
});

// утилиты
bot.command("chatid", (ctx) => ctx.reply("CHAT_ID: " + ctx.chat.id));

// Health
app.get("/", (_req, res) => res.send("OK"));

// Launch
const PORT = process.env.PORT || 3001;
const wantWebhook = !!PUBLIC_ORIGIN && /^https:\/\/[^/]+$/.test(PUBLIC_ORIGIN);

server.listen(PORT, () => console.log(`🚀 Server on :${PORT}`));

(async () => {
  try {
    const wh = await bot.telegram.getWebhookInfo();
    console.log("ℹ️  Webhook info:", {
      url: wh.url,
      pending: wh.pending_update_count,
      last_error_date: wh.last_error_date,
      last_error_message: wh.last_error_message,
    });

    if (wantWebhook) {
      const webhookPath = `/telegram/${BOT_TOKEN}`;
      const webhookUrl = `${PUBLIC_ORIGIN}${webhookPath}`;

      app.post(webhookPath, (req, res) => {
        bot.handleUpdate(req.body, res).then(() => res.sendStatus(200));
      });

      if (wh.url !== webhookUrl) {
        await bot.telegram.setWebhook(webhookUrl);
        console.log("🔗 Webhook set:", webhookUrl);
      } else {
        console.log("🔗 Webhook already set to this URL");
      }
    } else {
      if (wh.url) {
        await bot.telegram.deleteWebhook({ drop_pending_updates: false });
        console.log("🧹 Webhook deleted (switching to polling)");
      }
      bot
        .launch()
        .then(() => console.log("🛰️  Bot started with long-polling"))
        .catch((e) =>
          console.error(
            "❌ bot.launch error:",
            e?.response?.description || e.message
          )
        );
    }
  } catch (e) {
    console.error("❌ Launch error:", e?.response?.description || e.message);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
process.on("unhandledRejection", (e) => console.error("UNHANDLED:", e));
