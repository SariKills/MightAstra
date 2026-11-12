import crypto from 'crypto';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID ||0);

// Простая в памяти база данных для демонстрации. 
// Для продакшна рекомендуется подключить Supabase, Upstash Redis или MongoDB.
global.db = global.db || {
  messages: [], // { id, chatId, senderId, text, direction: 'in'|'out', createdAt, unread }
  contacts: new Map(), // chatId -> { id, firstName, username, lastText, lastAt, unread, blocked }
  quickReplies: [
    { id: 1, text: 'Здравствуйте! Спасибо за обращение в MightAstraAI 🙌 Чем могу помочь?' },
    { id: 2, text: 'Ваш запрос принят в работу. Скоро вернусь с ответом!' }
  ]
};

const db = global.db;

// Отправка сообщения в Telegram с префиксом MightAstraAI и логотипом
async function sendTelegramMessage(chatId, text, isOut = true) {
  let finalBody = text;
  if (isOut) {
    // Префикс и логотип рядом с сообщением администратора
    finalBody = `<b>✦ MightAstraAI</b>\n\n${text}`;
  }

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: finalBody,
      parse_mode: 'HTML'
    })
  });
  const data = await res.json();
  return data.ok ? data.result : null;
}

// Проверка подлинности Telegram InitData
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return false;
  try {
    const usp = new URLSearchParams(initData);
    const hash = usp.get('hash');
    usp.delete('hash');
    const params = Array.from(usp.entries()).sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = params.map(([k, v]) => `${k}=${v}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return calculatedHash === hash;
  } catch {
    return false;
  }
}

export async function handler(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-init-data',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const path = event.path.replace(/^\/\.netlify\/functions\/api/, '').replace(/^\/api/, '') || '/';
    const initData = event.headers['x-init-data'] || '';

    // 1. WEBHOOK ОТ TELEGRAM (когда пользователь пишет боту)
    if (path === '/telegram/webhook' && event.httpMethod === 'POST') {
      const update = JSON.parse(event.body || '{}');
      const msg = update.message || update.edited_message;
      
      if (msg && msg.text && !msg.from.is_bot) {
        const chatId = msg.chat.id;
        // Если пишет сам администратор в чат бота (опционально)
        if (chatId === ADMIN_ID) {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
        }

        const user = msg.from;
        const text = msg.text;

        // Сохраняем или обновляем контакт
        let contact = db.contacts.get(chatId) || {
          id: chatId,
          firstName: user.first_name || 'Пользователь',
          lastName: user.last_name || '',
          username: user.username || '',
          unread: 0,
          blocked: false
        };

        if (!contact.blocked) {
          contact.lastText = text;
          contact.lastAt = Date.now();
          contact.unread = (contact.unread || 0) + 1;
          db.contacts.set(chatId, contact);

          const messageId = ++db.idCounter || (db.idCounter = 1);
          db.messages.push({
            id: messageId,
            chatId,
            text,
            direction: 'in',
            createdAt: Date.now()
          });
        }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // Проверка авторизации через initData
    let user = { id: ADMIN_ID, first_name: 'Admin' };
    let isAdmin = false;

    if (initData) {
      if (verifyInitData(initData)) {
        const usp = new URLSearchParams(initData);
        const userObj = JSON.parse(usp.get('user') || '{}');
        user = userObj;
        isAdmin = Number(userObj.id) === ADMIN_ID;
      }
    } else if (process.env.NODE_ENV === 'development') {
      isAdmin = true; // Для локального тестирования
    }

    // 2. /api/me — информация о текущем пользователе
    if (path === '/me' && event.httpMethod === 'GET') {
      return { statusCode: 200, headers, body: JSON.stringify({ user, isAdmin }) };
    }

    // 3. /api/telegram/launch — ссылка на бота
    if (path === '/telegram/launch' && event.httpMethod === 'GET') {
      const botUsername = process.env.BOT_USERNAME || 'YourBotUsername';
      return { statusCode: 200, headers, body: JSON.stringify({ url: `https://t.me/${botUsername}?start=chat` }) };
    }

    // --- ПОЛЬЗОВАТЕЛЬСКИЕ МАРШРУТЫ (когда мини-приложение открывает обычный юзер) ---
    if (!isAdmin) {
      const userId = user.id;

      if (path === '/chat/messages' && event.httpMethod === 'GET') {
        const after = Number(event.queryStringParameters?.after || 0);
        const userMessages = db.messages.filter(m => m.chatId === userId && m.id > after);
        return { statusCode: 200, headers, body: JSON.stringify({ messages: userMessages }) };
      }

      if (path === '/chat/messages' && event.httpMethod === 'POST') {
        const { text } = JSON.parse(event.body || '{}');
        if (!text || !text.trim()) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Пустое сообщение' }) };
        }

        let contact = db.contacts.get(userId) || {
          id: userId,
          firstName: user.first_name || 'Пользователь',
          username: user.username || '',
          unread: 0,
          blocked: false
        };

        if (contact.blocked) {
          return { statusCode: 403, headers, body: JSON.stringify({ error: 'Вы заблокированы' }) };
        }

        contact.lastText = text;
        contact.lastAt = Date.now();
        db.contacts.set(userId, contact);

        const messageId = ++db.idCounter || (db.idCounter = 1);
        const newMsg = {
          id: messageId,
          chatId: userId,
          text,
          direction: 'in',
          createdAt: Date.now()
        };
        db.messages.push(newMsg);

        // Уведомляем администратора в личные сообщения в Telegram
        await sendTelegramMessage(ADMIN_ID, `📩 <b>Новое сообщение от ${user.first_name || userId}</b> (@${user.username || 'нет'}):\n\n${text}`, false);

        return { statusCode: 200, headers, body: JSON.stringify({ message: newMsg }) };
      }

      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Доступ запрещен' }) };
    }

    // --- АДМИНСКИЕ МАРШРУТЫ ---

    // Список контактов / диалогов
    if (path === '/admin/contacts' && event.httpMethod === 'GET') {
      const q = (event.queryStringParameters?.q || '').toLowerCase();
      const filter = event.queryStringParameters?.filter || 'all';

      let list = Array.from(db.contacts.values());

      if (filter === 'unread') list = list.filter(c => c.unread > 0);
      if (filter === 'blocked') list = list.filter(c => c.blocked);

      if (q) {
        list = list.filter(c => 
          String(c.id).includes(q) || 
          (c.firstName && c.firstName.toLowerCase().includes(q)) || 
          (c.username && c.username.toLowerCase().includes(q))
        );
      }

      list.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      const totalUnread = Array.from(db.contacts.values()).reduce((acc, c) => acc + (c.unread || 0), 0);

      return { statusCode: 200, headers, body: JSON.stringify({ contacts: list, totalUnread }) };
    }

    // Статистика
    if (path === '/admin/stats' && event.httpMethod === 'GET') {
      const people = db.contacts.size;
      const incoming = db.messages.filter(m => m.direction === 'in').length;
      const outgoing = db.messages.filter(m => m.direction === 'out').length;
      
      return { statusCode: 200, headers, body: JSON.stringify({
        people,
        incoming,
        outgoing,
        webhook: { connected: true, pending: 0 },
        bot: { username: process.env.BOT_USERNAME || 'Bot' }
      })};
    }

    // Настройка вебхука
    if (path === '/admin/setup' && event.httpMethod === 'POST') {
      const host = event.headers['host'];
      const webhookUrl = `https://${host}/api/telegram/webhook`;
      const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
      const tgData = await tgRes.json();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: tgData.ok }) };
    }

    // Получить историю сообщений с конкретным пользователем
    const contactMatch = path.match(/^\/admin\/contacts\/(-?\d+)(\/(messages|read|block))?$/);
    if (contactMatch) {
      const chatId = Number(contactMatch[1]);
      const action = contactMatch[3];
      const contact = db.contacts.get(chatId);

      if (!contact) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Диалог не найден' }) };
      }

      if (event.httpMethod === 'GET' && !action) {
        const after = Number(event.queryStringParameters?.after || 0);
        const read = event.queryStringParameters?.read === '1';
        
        if (read && contact.unread > 0) {
          contact.unread = 0;
          db.contacts.set(chatId, contact);
        }

        const chatMessages = db.messages.filter(m => m.chatId === chatId && m.id > after);
        return { statusCode: 200, headers, body: JSON.stringify({ contact, messages: chatMessages }) };
      }

      // Ответ администратора пользователю
      if (event.httpMethod === 'POST' && action === 'messages') {
        const { text } = JSON.parse(event.body || '{}');
        if (!text || !text.trim()) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Пустое сообщение' }) };
        }

        // Отправляем в Telegram с префиксом MightAstraAI
        const sent = await sendTelegramMessage(chatId, text, true);
        if (!sent) {
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Не удалось отправить сообщение в Telegram' }) };
        }

        contact.lastText = `Вы: ${text}`;
        contact.lastAt = Date.now();
        db.contacts.set(chatId, contact);

        const messageId = ++db.idCounter || (db.idCounter = 1);
        const newMsg = {
          id: messageId,
          chatId,
          text,
          direction: 'out',
          createdAt: Date.now()
        };
        db.messages.push(newMsg);

        return { statusCode: 200, headers, body: JSON.stringify({ message: newMsg }) };
      }

      if (event.httpMethod === 'POST' && action === 'read') {
        const { unread } = JSON.parse(event.body || '{}');
        contact.unread = unread ? 1 : 0;
        db.contacts.set(chatId, contact);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      if (event.httpMethod === 'POST' && action === 'block') {
        const { blocked } = JSON.parse(event.body || '{}');
        contact.blocked = blocked;
        db.contacts.set(chatId, contact);
        return { statusCode: 200, headers, body: JSON.stringify({ contact }) };
      }

      if (event.httpMethod === 'DELETE') {
        db.contacts.delete(chatId);
        db.messages = db.messages.filter(m => m.chatId !== chatId);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }
    }

    // Быстрые ответы (шаблоны)
    if (path === '/admin/quick-replies' && event.httpMethod === 'GET') {
      return { statusCode: 200, headers, body: JSON.stringify({ quickReplies: db.quickReplies }) };
    }

    if (path === '/admin/quick-replies' && event.httpMethod === 'POST') {
      const { text } = JSON.parse(event.body || '{}');
      const newReply = { id: Date.now(), text };
      db.quickReplies.push(newReply);
      return { statusCode: 200, headers, body: JSON.stringify({ quickReply: newReply }) };
    }

    const quickMatch = path.match(/^\/admin\/quick-replies\/(\d+)$/);
    if (quickMatch && event.httpMethod === 'DELETE') {
      const id = Number(quickMatch[1]);
      db.quickReplies = db.quickReplies.filter(q => q.id !== id);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Маршрут не найден' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
}