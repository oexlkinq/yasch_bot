import { Bot } from "./bot/index.js";
import { readFile } from 'node:fs/promises';
import { DB } from "./db.js";
import { SchApi } from "./bot/api.js";
import { Logger } from "./logger.js";

// проверка кол-ва аргументов
if (process.argv.length - 2 < 1) {
    console.error(`синтаксис запуска:\nnode launcher.js your_config.json`);

    process.exit(1);
}

// получение конфигурации
const rawconfig = await readFile(process.argv[2 + 0], { encoding: 'utf-8' });
const config = JSON.parse(rawconfig) as config;
console.log(`conf desc: ${config.description}`);

// подготовка компонентов
const logger = await Logger.make(
    config.logger.tgbot_token,
    config.logger.chat_id,
    config.logger.msgdump_file,
)

const schapi = new SchApi(config.api_address)
const db = new DB(config.pg_connection_string, logger)

const bot = await Bot.make(
    db,
    schapi,
    config.tgbot_token,
    logger,
)

// запуск бота
await bot.start(config.skip_startup_burst)


type config = {
    description: string,
    tgbot_token: string,
    api_address: string,
    pg_connection_string: string,
    skip_startup_burst: boolean,

    logger: {
        tgbot_token: string,
        chat_id: number,
        msgdump_file: string,
    },
};
