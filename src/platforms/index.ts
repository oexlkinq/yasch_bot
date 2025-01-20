import { dbUser } from "../db.js"
import { Bot } from "../baseBot/index.js"

export abstract class PlatformSpecificBot {
    abstract start(router: Bot['router'], skipStartupBurst: boolean): Promise<void>
    abstract mailingSend(user_id: number, text: string): Promise<void>
}

export const platformNames = ['tg', 'vk'] as const
export type platforms = typeof platformNames[number]
