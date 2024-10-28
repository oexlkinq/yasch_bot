import { APIError, Keyboard, VK } from "vk-io"
import Bottleneck from "bottleneck"
import { Pool } from "pg"
import { User } from "../db.js"
import { Bot } from "../baseBot/index.js"
import { PlatformSpecificBot } from "./index.js"

export class VkBot implements PlatformSpecificBot {
    vk: VK
    mailingLimiter: Bottleneck

    constructor(
        token: string,
        group_id: number,
        public pool: Pool,
    ) {
        this.vk = new VK({
            token,
            apiLimit: 20,
            pollingGroupId: group_id,
        })
        this.mailingLimiter = new Bottleneck({
            maxConcurrent: 15,
            minTime: 1000 / 15,
        })
    }

    mailingSend(peer_id: number, text: string) {
        return this.mailingLimiter.schedule(async () => {
            try {
                await this.vk.api.messages.send({
                    peer_id: peer_id,
                    random_id: Date.now(),
                    message: text,
                })
            } catch (e) {
                if (e instanceof APIError && String(e.code) === '902') {
                    await User.drop(this.pool, peer_id, 'vk')
                    console.warn(`(vk) user ${peer_id} was dropped`)

                    return
                }

                throw e
            }
        })
    }

    async start(router: Bot['router'], allowSkipStartupBurst = true) {
        // прикрепить обработчик сообщений
        this.vk.updates.on('message_new', async (msg, next) => {
            if(msg.isOutbox){
                return
            }

            if (!msg.text) {
                return
            }
            
            const from = 'vk: ' + msg.senderId
            const response = await router(
                (msg.text.toLocaleLowerCase() === 'начать') ? {
                    start: true,
                    from, 
                } : {
                    text: msg.text.replace(/\[.*?\]/, ''),
                    from,
                },
                () => User.make(this.pool, msg.peerId, 'vk'),
            )

            await msg.send(response, {
                keyboard: VkBot.keyboard,
            })
            
            return next()
        });

        // запуск обработки сообщений
        console.log('(vk) start polling...')
        return this.vk.updates.startPolling()
    }

    static keyboard = Keyboard.builder()
        .textButton({ label: 'Сегодня' })
        .textButton({ label: 'Завтра' })
        .textButton({ label: 'Неделя' })
        .textButton({ label: 'Сл неделя' })
        .row()
        .textButton({ label: 'Справка' })
        .textButton({ label: 'Звонки' })
        .textButton({ label: 'Статус' })
        .row()
}