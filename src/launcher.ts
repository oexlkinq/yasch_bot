import { Bot } from "./baseBot/index.js";
import { readFile } from 'node:fs/promises';
import { DB } from "./db.js";
import { SchApi } from "./api.js";
import { Logger } from "./logger.js";
import { MsgAnalyser } from "./baseBot/msgAnalyser/index.js";
import { scheduleJob } from "node-schedule";
import { TgBot } from "./platforms/tg.js";
import { VkBot } from "./platforms/vk.js";

// проверка кол-ва аргументов
if (process.argv.length - 2 < 1) {
    console.error(`синтаксис запуска:\nnode launcher.js your_config.json`);

    process.exit(1);
}

// получение конфигурации
const rawconfig = await readFile(process.argv[2 + 0], { encoding: 'utf-8' });
const config = JSON.parse(rawconfig) as config;
console.log(`--conf desc: ${config.description}`);

// подготовка компонентов
const logger = await Logger.make(
    config.logger.tgbot_token,
    config.logger.chat_id,
    config.logger.msgdump_file,
)

const schapi = new SchApi(config.api_address)
const db = new DB(config.pg_connection_string, logger)
const msgAnalyser = new MsgAnalyser()
const bot = new Bot(msgAnalyser, schapi, db, logger)

const tgbot = new TgBot(config.tg.token, db.pool)
const vkbot = new VkBot(config.vk.token, config.vk.group_id, db.pool)

const sendFuncs = {
    'tg': tgbot.mailingSend.bind(tgbot),
    'vk': vkbot.mailingSend.bind(vkbot),
}

// создание задач рассылки
scheduleJob('0 7 * 1-6,9-12 1-6', async () => {
    try {
        await bot.startMailing(sendFuncs, new Date(), '📕 Расписание занятий на сегодня')
    } catch (e) {
        console.error(e)
        logger.logToChat('бот. рассылка сегодня', e)
    }
});
scheduleJob('0 19 * 1-6,9-12 0-5', async () => {
    try {
        const date = new Date()
        date.setDate(date.getDate() + 1)

        await bot.startMailing(sendFuncs, date, '📗 Расписание занятий на завтра')
    } catch (e) {
        console.error(e)
        logger.logToChat('бот. рассылка сл день', e)
    }
});

// @ts-ignore
await bot.router({ text: 'звонки ради подогреть роутер', from: 'admin' }, async () => 'my bad')

// запуск бота
tgbot.start(bot.router.bind(bot), config.skip_startup_burst)
vkbot.start(bot.router.bind(bot), config.skip_startup_burst)

type config = {
    /** описание конфигурации */
    description: string,
    /** адрес апи расписания */
    api_address: string,
    /** URI подключения к базе */
    pg_connection_string: string,
    /** пропустить накопившиеся в ботах запросы при старте? */
    skip_startup_burst: boolean,

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
