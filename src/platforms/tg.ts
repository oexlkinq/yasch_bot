import Bottleneck from "bottleneck"
import { Pool } from "pg"
import { User } from "../db.js"
import { Bot } from "../baseBot/index.js"
import { PlatformSpecificBot } from "./index.js"

import { Telegraf, TelegramError } from "telegraf"
import { Message, ReplyKeyboardMarkup } from "telegraf/types"
import { message } from "telegraf/filters"

export class TgBot implements PlatformSpecificBot {
    bot: Telegraf
    generalLimiter: Bottleneck
    mailingLimiter: Bottleneck

    constructor(
        token: string,
        public pool: Pool,
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

    async start(router: Bot['router'], skipStartupBurst = true) {
        // пропустить накопившиеся сообщения
        if (skipStartupBurst) {
            console.log('(tg) skip burst...');

            const updates = await this.bot.telegram.getUpdates(0, 0, -100, ['message'])

            updates.forEach(update => {
                if(!('message' in update && 'text' in update.message)){
                    return
                }

                const msg = update.message

                console.log(`(tg) ${TgBot.senderOf(msg)}: ${msg.text ?? '__nothing__'}`)
            })
        }

        // обновить список команд
        console.log('(tg) update commands...');
        await this.bot.telegram.setMyCommands([
            {
                command: 'start',
                description: 'Короткая справка + показать кнопки',
            }
        ])

        // прикрепить обработчик сообщений
        this.bot.on(message('text'), async (ctx) => {
            const response = await router(
                (ctx.text.startsWith('/start')) ? { start: true } : {
                    text: ctx.text,
                    from: 'tg: ' + TgBot.senderOf(ctx.msg),
                },
                () => User.make(this.pool, ctx.chat.id, 'tg'),
            )
            
            await this.generalLimiter.schedule(
                () => ctx.reply(
                    response,
                    { reply_markup: TgBot.keyboardReplyMarkup },
                )
            )
        });

        // запуск обработки сообщений
        console.log('(tg) start polling...')
        return this.bot.launch()
    }

    static senderOf(msg: Message) {
        if (msg.from) {
            if (msg.from.username) {
                return '@' + msg.from.username
            } else {
                return `${msg.from.first_name} ${msg.from.last_name ?? ''}`
            }
        } else {
            return msg.chat.type
        }
    }

    static keyboardReplyMarkup: ReplyKeyboardMarkup = {
        keyboard: [
            [
                { text: 'Сегодня' },
                { text: 'Завтра' },
                { text: 'Неделя' },
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