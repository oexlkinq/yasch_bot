import TelegramBot from "node-telegram-bot-api"
import Bottleneck from "bottleneck"
import { Pool } from "pg"
import { User } from "../db.js"
import { Bot } from "../baseBot/index.js"
import { platforms, PlatformSpecificBot } from "./index.js"

export class TgBot implements PlatformSpecificBot{
    tgbot: TelegramBot
    generalLimiter: Bottleneck
    mailingLimiter: Bottleneck

    constructor(
        token: string,
        public pool: Pool,
    ) {
        this.tgbot = new TelegramBot(token)
        this.generalLimiter = new Bottleneck({
            maxConcurrent: 30,
            reservoir: 30,
            reservoirRefreshAmount: 30,
            reservoirRefreshInterval: 1000,
        })
        this.mailingLimiter = new Bottleneck({
            maxConcurrent: 25,
            minTime: 1000 / 25,
        })
        this.mailingLimiter.chain(this.generalLimiter)
    }

    mailingSend(user_id: number, text: string) {
        return this.mailingLimiter.schedule(async () => {
            try {
                await this.tgbot.sendMessage(user_id, text)
            } catch (e) {
                // https://github.com/yagop/node-telegram-bot-api/blob/master/doc/usage.md#error-handling
                if (e instanceof Object && 'code' in e && e.code === 'ETELEGRAM') {
                    // @ts-ignore TODO
                    const error_code = e.response?.body?.error_code
                    if ([400, 403].includes(error_code)) {
                        await User.drop(this.pool, user_id, 'tg')
                        console.warn(`user ${user_id} was dropped`)

                        return
                    }
                }

                throw e
            }
        })
    }

    async start(router: Bot['router'], skipStartupBurst = true) {
        // пропустить накопившиеся сообщения
        if (skipStartupBurst) {
            console.log('(tg) skip burst...');

            const updates = await this.tgbot.getUpdates({
                offset: -100,
                allowed_updates: ['message'],
            })

            updates.forEach(update => {
                const msg = update.message
                if (!msg) {
                    return
                }

                console.log(`(tg) ${TgBot.senderOf(msg)}: ${msg.text ?? '__nothing__'}`)
            })
        }

        // обновить список команд
        console.log('(tg) update commands...');
        await this.tgbot.setMyCommands([
            {
                command: 'start',
                description: 'Короткая справка + показать кнопки',
            }
        ])

        // прикрепить обработчик сообщений
        this.tgbot.on('message', async (msg) => {
            if (!msg.text) {
                return
            }

            const response = await router(
                {
                    text: msg.text,
                    from: 'tg:' + TgBot.senderOf(msg),
                },
                () => User.make(this.pool, msg.chat.id, 'tg'),
            )

            await this.generalLimiter.schedule(
                () => this.tgbot.sendMessage(
                    msg.chat.id,
                    response,
                    { reply_markup: TgBot.keyboardReplyMarkup },
                )
            )
        });

        // запуск обработки сообщений
        console.log('(tg) start polling...')
        return this.tgbot.startPolling({
            polling: true,
        })
    }

    static senderOf(msg: TelegramBot.Message) {
        if (msg.from) {
            if (msg.from.username) {
                return '@' + msg.from.username
            } else {
                return `${msg.from.first_name} ${msg.from.last_name}`
            }
        } else {
            return msg.chat.type
        }
    }

    static keyboardReplyMarkup: TelegramBot.ReplyKeyboardMarkup = {
        keyboard: [
            [
                { text: 'Сегодня' },
                { text: 'Завтра' },
                { text: 'Неделя' },
            ],
            [
                { text: 'Справка' },
                { text: 'Звонки' },
                { text: 'Файлы' },
            ],
        ],
        resize_keyboard: true,
        is_persistent: true,
    }
}