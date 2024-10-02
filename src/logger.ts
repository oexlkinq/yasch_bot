import { open } from 'node:fs/promises';
import { WriteStream } from 'node:fs'
import { Telegraf } from 'telegraf';
import Bottleneck from 'bottleneck';

export class Logger {
    private constructor(
        public chat_id: number,
        public tgbot: Telegraf,
        public limiter: Bottleneck,
        private msgDumpStream: WriteStream,
    ) { }

    static async make(token: string, chat_id: number, msgDumpFile: string) {
        const tgbot = new Telegraf(token)
        const limiter = new Bottleneck({
            maxConcurrent: 20,
            reservoir: 20,
            reservoirRefreshAmount: 20,
            reservoirRefreshInterval: 1000,
        })
        
        const fd = await open(msgDumpFile, 'a');
        const stream = fd.createWriteStream();

        return new Logger(chat_id, tgbot, limiter, stream)
    }

    logToChat(scope: string, e?: unknown) {
        this.limiter.schedule(
            () => this.tgbot.telegram.sendMessage(
                this.chat_id,
                scope + ((e === undefined) ? '' : `\n<code>${String(e)}</code>`),
                { parse_mode: 'HTML' },
            )
        ).catch((e) => console.error(new Error('(Logger) Не удалось отправить оповещение об ошибке', {cause: e})))
    }

    dumpRequest(requestInfo: string, response: string, dumpType = 'msgdump') {
        const text = [
            Logger.datetimeToIsolikeString(new Date()),
            dumpType,
            requestInfo,
            response.replaceAll('\n', '#').slice(0, 50),
        ].join('\t~') + '\n'

        this.msgDumpStream.write(text)
    }

    static datetimeToIsolikeString(date: Date) {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')

        const hour = String(date.getHours()).padStart(2, '0')
        const minute = String(date.getMinutes()).padStart(2, '0')
        const second = String(date.getSeconds()).padStart(2, '0')
        const millis = String(date.getMilliseconds()).padStart(3, '0')

        return `${year}-${month}-${day} ${hour}:${minute}:${second}.${millis}`
    }
}