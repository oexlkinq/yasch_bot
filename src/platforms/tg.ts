import Bottleneck from "bottleneck"
import { Pool } from "pg"
import { User } from "../db.js"
import { Bot } from "../baseBot/index.js"
import { PlatformSpecificBot } from "./index.js"

import { Telegraf, TelegramError } from "telegraf"
import { Message, ReplyKeyboardMarkup, Update } from "telegraf/types"
import { message } from "telegraf/filters"
import { Logger } from "../logger.js"

export class TgBot implements PlatformSpecificBot {
    bot: Telegraf
    generalLimiter: Bottleneck
    mailingLimiter: Bottleneck

    constructor(
        token: string,
        public pool: Pool,
        public logger: Logger,
    ) {
        this.bot = new Telegraf(token)
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

    mailingSend(chat_id: number, text: string) {
        return this.mailingLimiter.schedule(async () => {
            try {
                await this.bot.telegram.sendMessage(chat_id, text)
            } catch (e) {
                if (e instanceof TelegramError) {
                    if ([400, 403].includes(e.code)) {
                        await User.drop(this.pool, chat_id, 'tg')
                        console.warn(`(tg) user ${chat_id} was dropped`)

                        return
                    }
                }

                throw e
            }
        })
    }

    async start(router: Bot['router'], allowSkipStartupBurst = true) {
        // прикрепить обработчик сообщений
        this.bot.on(message('text'), async (ctx) => {
            const from = 'tg: ' + TgBot.senderOf(ctx.msg)
            const response = await router(
                (ctx.text.startsWith('/start')) ? {
                    start: true,
                    from,
                } : {
                    text: ctx.text,
                    from,
                },
                () => User.make(this.pool, ctx.chat.id, 'tg'),
            )

            // пытаться отправить сообщение до 3 раз
            for (let retries = 0; retries < 3; retries++) {
                try {
                    await this.generalLimiter.schedule(
                        async () => await ctx.reply(
                            response,
                            { reply_markup: TgBot.keyboardReplyMarkup },
                        )
                    )

                    // закончить попытки при первой успешной отправке
                    break
                } catch (e) {
                    // попытаться снова если ещё можно и ошибка ECONNRESET
                    if (
                        retries < 3
                        && e instanceof Error
                        && 'errno' in e
                        && e.errno === 'ECONNRESET'
                    ) {
                        continue
                    }

                    // закончить попытки при любых иных ошибках. ошибка будет перехвачена в bot.catch
                    throw e
                }
            }
        });

        // ловить ошибки и отправлять их в чат
        this.bot.catch((err, ctx) => {

            this.logger.logToChat('bot.catch', err)
            console.error(err, ctx)
        })

        // обработать только последнее из накопившихся сообщений в каждом чате
        if (allowSkipStartupBurst) {
            console.log('(tg) process burst...');

            let offset = 0
            /** карта соответствий "чат - последний апдейт чата" */
            const latestUpdatesOfChats = new Map<number, Update.MessageUpdate>()

            while (true) {
                const updates = await this.bot.telegram.getUpdates(0, 100, offset, ['message'])

                if (updates.length === 0) {
                    break
                }

                for (const update of updates) {
                    if (!('message' in update)) {
                        continue
                    }

                    const chatId = update.message.chat.id
                    const tempUpdateId = update.update_id

                    const latestChatUpdate = latestUpdatesOfChats.get(chatId)
                    // если это первый апдейт в этом чате, или текущий апдейт новее апдейта из карты, заменить апдейт в карте на текущий
                    if (!latestChatUpdate || tempUpdateId > latestChatUpdate.update_id) {
                        latestUpdatesOfChats.set(chatId, update)

                        if (latestChatUpdate) {
                            logRejectedUpdate(latestChatUpdate)
                        }
                    } else {
                        logRejectedUpdate(update)
                    }

                    if (tempUpdateId > offset) {
                        offset = tempUpdateId
                    }

                    function logRejectedUpdate(update: Update.MessageUpdate) {
                        console.log(`(tg) (отброшено) ${TgBot.senderOf(update.message)}: ${('text' in update.message) ? update.message.text : '__nothing__'}`)
                    }
                }

                // смещение должно быть на 1 больше чем id самого последнего обработанного апдейта
                offset++
            }

            const updates = Array.from(latestUpdatesOfChats.values())
            await Promise.all(updates.map((update) => this.bot.handleUpdate(update)))
        }

        // обновить список команд
        console.log('(tg) update commands...');
        await this.bot.telegram.setMyCommands([
            {
                command: 'start',
                description: 'Короткая справка + показать кнопки',
            }
        ])

        // запуск обработки сообщений
        console.log('(tg) start polling...')
        return this.bot.launch()
    }

    static senderOf(msg: Message) {
        const idInfo = ` (${msg.chat.id})`
        if (msg.from) {
            if (msg.from.username) {
                return '@' + msg.from.username + idInfo
            } else {
                return `${msg.from.first_name} ${msg.from.last_name ?? ''}` + idInfo
            }
        } else {
            return msg.chat.type + idInfo
        }
    }

    static keyboardReplyMarkup: ReplyKeyboardMarkup = {
        keyboard: [
            [
                { text: 'Сегодня' },
                { text: 'Завтра' },
                { text: 'Неделя' },
                { text: 'Сл неделя' },
            ],
            [
                { text: 'Справка' },
                { text: 'Звонки' },
                { text: 'Статус' },
            ],
        ],
        resize_keyboard: true,
        is_persistent: true,
    }
}