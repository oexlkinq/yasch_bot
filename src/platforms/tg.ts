import Bottleneck from "bottleneck"
import { Pool } from "pg"
import { User } from "../db.js"
import { Bot } from "../baseBot/index.js"
import { PlatformSpecificBot } from "./index.js"

import { Telegraf, Telegram, TelegramError } from "telegraf"
import { Message, ReplyKeyboardMarkup, Update } from "telegraf/types"
import { message } from "telegraf/filters"
import { Logger } from "../logger.js"
import { filterObj } from "./tg_web_app_api.js"


export class TgBot implements PlatformSpecificBot {
    tf: Telegraf
    generalLimiter: Bottleneck
    mailingLimiter: Bottleneck

    constructor(
        private token: string,
        public pool: Pool,
        public logger: Logger,
        testEnv: boolean,
    ) {

        this.tf = new Telegraf(this.token, { telegram: { testEnv } })
        this.generalLimiter = new Bottleneck({
            maxConcurrent: 15,
            reservoir: 30,
            reservoirRefreshAmount: 30,
            reservoirRefreshInterval: 1000,
        })
        this.mailingLimiter = new Bottleneck({
            maxConcurrent: 10,
            minTime: 1000 / 25,
        })
        this.mailingLimiter.chain(this.generalLimiter)

    }

    async start(router: Bot['router'], allowSkipStartupBurst = true) {
        // прикрепить обработчик сообщений
        this.tf.on(message('text'), async (ctx) => {
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

        // прикрепить обработчик блокировки бота пользователями
        this.tf.on('my_chat_member', async (ctx) => {
            if (ctx.myChatMember.new_chat_member.status === 'kicked') {
                const qres = await User.drop(this.pool, ctx.myChatMember.chat.id, 'tg')

                this.logger.dumpRequest(JSON.stringify({ from: TgBot.senderOf(ctx.myChatMember), dbUser: qres.rows[0] }), 'blocked by user', 'blocked')
            }
        })

        // ловить ошибки и отправлять их в чат
        this.tf.catch((err, ctx) => {

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
                const updates = await this.tf.telegram.getUpdates(0, 100, offset, ['message'])

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
            await Promise.all(updates.map((update) => this.tf.handleUpdate(update)))
        }

        // обновить список команд
        console.log('(tg) update commands...');
        await this.tf.telegram.setMyCommands([
            {
                command: 'start',
                description: 'Короткая справка + показать кнопки',
            }
        ])

        // Enable graceful stop
        // process.once('SIGINT', () => this.tf.stop('SIGINT'))
        // process.once('SIGTERM', () => this.tf.stop('SIGTERM'))

        // запуск обработки сообщений
        console.log('(tg) start polling...')
        return this.tf.launch()
    }

    mailingSend(chat_id: number, text: string) {
        return this.mailingLimiter.schedule(async () => {
            try {
                await this.tf.telegram.sendMessage(chat_id, text)
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

    isMailingActive = false
    async runMailing(statusChatId: number, text: string, filter: filterObj, statusUpdateTimeout = 2000) {
        try {
            this.isMailingActive = true
    
            const send = this.mailingLimiter.wrap(this.tf.telegram.sendMessage.bind(this.tf.telegram))
    
            const chatIds = await User.getByFilter(this.pool, filter)
    
            const contentMsg = await send(statusChatId, text)
            const statusMsg = await send(statusChatId, `Запущена рассылка\nТекущий прогресс: 0 / ${chatIds.length}`)
    
            let progress = 0
            let prevProgress = progress
            const updateStatus = async () => {
                if (prevProgress === progress) {
                    return
                }
                prevProgress = progress
    
                await this.mailingLimiter.schedule(() => this.tf.telegram.editMessageText(
                    statusMsg.chat.id,
                    statusMsg.message_id,
                    undefined,
                    `Запущена рассылка\nТекущий прогресс: ${progress} / ${chatIds.length}`,
                ))
    
                if (progress !== chatIds.length) {
                    setTimeout(updateStatus, statusUpdateTimeout)
                }
            }
            setTimeout(updateStatus, statusUpdateTimeout)
    
            let errorsCount = 0
            for (const [chatId] of chatIds) {
                if (chatId === statusChatId) {
                    continue
                }
    
                try {
                    await this.mailingLimiter.schedule(async () => await this.tf.telegram.copyMessage(
                        chatId,
                        contentMsg.chat.id,
                        contentMsg.message_id,
                    ))
                } catch (e) {
                    console.error(e)
                    errorsCount++
                }
    
                progress++
            }
    
            if (errorsCount !== 0) {
                this.logger.logToChat('tg.runMailing', `рассылка: "${text.slice(0, 50)}"\nкол-во ошибок: ${errorsCount}`)
            }
    
        } catch(e) {
            console.error(e)
            this.logger.logToChat('tgbot.runMailing.общий try', e)
        } finally {
            this.isMailingActive = false
        }
    }

    static senderOf(msgLike: Pick<Message, 'chat' | 'from'>) {
        const idInfo = ` (${msgLike.chat.id})`
        if (msgLike.from) {
            if (msgLike.from.username) {
                return '@' + msgLike.from.username + idInfo
            } else {
                return `${msgLike.from.first_name} ${msgLike.from.last_name ?? ''}` + idInfo
            }
        } else {
            return msgLike.chat.type + idInfo
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