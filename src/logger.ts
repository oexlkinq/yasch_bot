import { open } from 'node:fs/promises';
import { WriteStream } from 'node:fs'
import TelegramBot from 'node-telegram-bot-api';
import Bottleneck from 'bottleneck';

export class Logger {
    private constructor(
        public chat_id: number,
        public tgbot: TelegramBot,
        public limiter: Bottleneck,
        private msgDumpStream: WriteStream,
    ) { }

    static async make(token: string, chat_id: number, msgDumpFile: string) {
        const tgbot = new TelegramBot(token)
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

    logToChat(title: string, e?: unknown) {
        this.limiter.schedule(
            () => this.tgbot.sendMessage(
                this.chat_id,
                title + ((e === undefined) ? '' : `\n<code>${String(e)}</code>`),
                { parse_mode: 'HTML' },
            )
        ).catch((e) => console.error(new Error('(Logger) Не удалось отправить оповещение об ошибке', {cause: e})))
    }

    dumpMsg(msg: TelegramBot.Message, reply: string) {
        const text = [
            new Date().toISOString(),
            'msgdump',
            msg.chat.id,
            msg.from?.id ?? '-',
            msg.from?.username ?? '-',
            msg.from?.first_name ?? '-',
            msg.text ?? '-',
            reply.replaceAll('\n', '#').slice(0, 50),
        ].join('\t~') + '\n'

        this.msgDumpStream.write(text)
    }
}