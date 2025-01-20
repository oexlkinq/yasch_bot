import { Bot } from "./baseBot/index.js";
import { readFile } from 'node:fs/promises';
import { DB } from "./db.js";
import { SchApi } from "node-sch-api";
import { Logger } from "./logger.js";
import { MsgAnalyser } from "./baseBot/msgAnalyser/index.js";
import { scheduleJob } from "node-schedule";
import { TgBot } from "./platforms/tg.js";
import { VkBot } from "./platforms/vk.js";
import { WebAppApi } from "./platforms/tg_web_app_api.js";

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

const tgbot = new TgBot(config.tg.token, db.pool, logger, config.tg.testEnv)
const webApp = new WebAppApi(tgbot, db.pool, schapi, config.tg.token, config.tg.web_app.api_port, config.tg.web_app.address)
const vkbot = new VkBot(config.vk.token, config.vk.group_id, db.pool)

const sendFuncs = {
    'tg': tgbot.mailingSend.bind(tgbot),
    'vk': vkbot.mailingSend.bind(vkbot),
}

// создание задач рассылки
scheduleJob('0 7 * 1-6,9-12 1-6', async () => {
    if (isNewYear()) {
        return
    }
    
    try {
        await bot.startMailing(sendFuncs, false)
    } catch (e) {
        console.error(e)
        logger.logToChat('бот. рассылка сегодня', e)
    }
});
scheduleJob('0 19 * 1-6,9-12 0-5', async () => {
    if (isNewYear()) {
        return
    }
    
    try {
        await bot.startMailing(sendFuncs, true)
    } catch (e) {
        console.error(e)
        logger.logToChat('бот. рассылка сл день', e)
    }
});
function isNewYear() {
    const date = new Date()

    const preNewYear = (date.getMonth() === 11) && (date.getDate() === 31)
    const postNewYear = (date.getMonth() === 0) && (date.getDate() < 8)

    return preNewYear || postNewYear
}

// запуск рассылки для тестирования
if (process.argv.includes('mailnow')) {
    console.log('--запуск тестовой рассылки')

    await bot.startMailing(sendFuncs, process.argv.includes('nextday'))
}

// @ts-ignore
await bot.router({ text: 'звонки ради подогреть роутер', from: 'admin' }, async () => 'my bad')

// запуск бота
tgbot.start(bot.router.bind(bot), config.allow_skip_startup_burst)
webApp.start()
vkbot.start(bot.router.bind(bot), config.allow_skip_startup_burst)

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
        testEnv: boolean,
        web_app: {
            api_port: number,
            address: string,
        },
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
