import { DB } from "./db.js";
import { readFile, writeFile } from 'node:fs/promises'
import { Logger } from "./logger.js";
import Bottleneck from "bottleneck";
import { Telegram } from "telegraf";

// проверка кол-ва аргументов
if (process.argv.length - 2 < 3) {
    console.error(`синтаксис запуска:\nnode mailer.js your_config.json temp_chat_id msg_text_file.txt`);

    process.exit(1);
}

const [configPath, rawTempChatId, msgTextFilePath] = process.argv.slice(3)

// получение конфигурации
const rawconfig = await readFile(configPath, { encoding: 'utf-8' });
const config = JSON.parse(rawconfig) as config;
console.log(`--conf desc: ${config.description}`);

const logger = await Logger.make(
    config.logger.tgbot_token,
    config.logger.chat_id,
    'mailer_dump.log',
)
const db = new DB(config.pg_connection_string, logger)
const limiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 1000 / 20,
})

const bot = new Telegram(config.tg.token)

const tempChatId = +rawTempChatId
const text = await readFile(msgTextFilePath, { encoding: 'utf-8' })
const msg = await bot.sendMessage(tempChatId, text)
const send = limiter.wrap((id: number) => bot.copyMessage(id, tempChatId, msg.message_id))

const users = await db.pool.query<{ id: number }>(`select id from users where platform = 'tg'`)

const dist = 100
let distI = 0
let badUsers: { id: number, cause: string }[] = []
for (let i = 0; i < users.rows.length; i++) {
    const { id } = users.rows[i]

    try {
        await send(id)
    } catch (e) {
        badUsers.push({
            id,
            cause: String(e),
        })
    }

    if (distI === dist) {
        distI = 0
        console.log(`sent ${i} msg`)
    }
    distI++
}
console.log(`sent all ${users.rows.length}`)

console.log(`write bad. count: ${badUsers.length}`)
await writeFile('bad.json', JSON.stringify(badUsers), 'utf-8')

await db.pool.end()


type config = {
    /** описание конфигурации */
    description: string,
    /** адрес апи расписания */
    api_address: string,
    /** URI подключения к базе */
    pg_connection_string: string,
    /** разрешить пропускать накопившиеся в ботах запросы при старте? */
    allow_skip_startup_burst: boolean,

    /** специфичные для тг бота настройки */
    tg: {
        /** токен тг бота */
        token: string,
    },
    /** специфичные для вк бота настройки */
    vk: {
        /** токен вк бота */
        token: string,
        /** id сообщества от лица которого работает бот */
        group_id: number,
    },

    /** настройки логгера */
    logger: {
        /** токен тг бота для отправки ошибок */
        tgbot_token: string,
        /** id чата для отправки ошибок */
        chat_id: number,
        /** файл для лога запросов */
        msgdump_file: string,
    },
};
