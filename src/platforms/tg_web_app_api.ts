import Koa from 'koa'
import zodRouter from 'koa-zod-router'
import { z } from 'zod'
import { TgBot } from './tg.js'
import { createHmac } from 'node:crypto'
import { User } from '../db.js'
import pg from 'pg'
import { platformNames, platforms } from './index.js'
import { Bot } from '../baseBot/index.js'
import { SchApi } from 'node-sch-api'

export class WebAppApi {
    app: Koa
    router: ReturnType<typeof zodRouter<state>>
    hmacSecretKey: Buffer

    constructor(
        private tgbot: TgBot,
        private pool: pg.Pool,
        private schApi: SchApi,
        private token: string,
        private port: number,
        private webAppAddress: string,
    ) {
        this.app = new Koa()
        this.app.use(async (ctx, next) => {
            ctx.set('access-control-allow-origin', '*')

            await next()
        })

        this.router = zodRouter<state>({
            zodRouter: { exposeRequestErrors: true, exposeResponseErrors: true },
        })

        /** middleware для валидации initData и занесения данных в state */
        this.router.use({
            handler: async (ctx, next) => {
                const { body } = ctx.request
                const data = this.parseInitData(body.initData)

                if (!data) {
                    return ctx.throw(403, 'invalid initData')
                }

                if (!data.user) {
                    return ctx.throw(400, 'missing user info')
                }

                ctx.state.initDataObj = data
                ctx.state.user = data.user
                ctx.state.platform = body.platform

                await next()
            },
            validate: {
                body: WebAppApi.requestParams,
            },
        })

        this.router.register({
            name: 'mailing/run',
            method: 'post',
            path: '/mailing/run',
            handler: async (ctx) => {
                const unsafeUser = await User.make(this.pool, ctx.state.user.id, ctx.state.platform)
                if (!unsafeUser.can_run_mailing) {
                    return ctx.throw(403, 'not allowed method')
                }

                if (this.tgbot.isMailingActive) {
                    return ctx.throw(503, 'another mailing is active')
                }

                this.tgbot.runMailing(ctx.state.user.id, ctx.request.body.text, ctx.request.body.filters).catch((e) => {
                    console.error(e)
                })

                ctx.body = 'started'
            },
            validate: {
                body: z.object({
                    filters: WebAppApi.filtersObj,
                    text: z.string(),
                }),
            },
        })

        this.router.register({
            name: 'mailing/coverage',
            method: 'post',
            path: '/mailing/coverage',
            handler: async (ctx) => {
                const unsafeUser = await User.make(this.pool, ctx.state.user.id, ctx.state.platform)
                if (!unsafeUser.can_run_mailing) {
                    return ctx.throw(403, 'not allowed method')
                }

                ctx.body = JSON.stringify({
                    recipientsCount: await User.countByFilter(this.pool, ctx.request.body.filters),
                })
            },
            validate: {
                body: z.object({
                    filters: WebAppApi.filtersObj,
                }),
            },
        })

        this.router.register({
            name: 'user/get',
            method: 'post',
            path: '/user/get',
            handler: async (ctx) => {
                const unsafeUser = await User.make(this.pool, ctx.state.user.id, ctx.state.platform)

                const user = Object.assign({}, unsafeUser, { pool: undefined, })

                ctx.body = JSON.stringify(user)
            },
        })

        this.router.register({
            name: 'user/update',
            method: 'post',
            path: '/user/update',
            handler: async (ctx) => {
                const user = await User.make(this.pool, ctx.state.user.id, ctx.state.platform)
                await user.put(ctx.request.body.user)

                ctx.body = 'updated'
            },
            validate: {
                body: z.object({
                    user: z.object({
                        notify: z.boolean(),
                        format: z.number().min(0).max(2),
                        group_name: z.nullable(
                            z.string().min(3).toLowerCase().refine(async (value) => {
                                let res = false
                                try {
                                    res = (await this.schApi.groups.test(value)).available
                                } catch (e) {
                                    console.error(e)
                                }

                                return res
                            }, { message: 'Для указанной группы расписание ещё никогда не публиковалось' })
                        ),
                        query: z.nullable(
                            z.string().min(3).toLowerCase().superRefine((val, ctx) => {
                                const valRes = Bot.validateQuery(val)
                                if (valRes !== true) {
                                    ctx.addIssue({
                                        code: z.ZodIssueCode.custom,
                                        fatal: true,
                                        message: valRes,
                                    })
                                }
                            })
                        ),
                        // TODO: faculty_id лучше бы валидировать с помощью данных из БД
                        faculty_ids: z.nullable(
                            z.array(z.number().min(1).max(14)).min(1)
                        ),
                        wants_mailing: z.boolean(),
                        role: z.nullable(z.union([z.literal('student'), z.literal('teacher')])),
                    })
                })
            }
        })

        this.router.register({
            name: 'user/testGroup',
            path: '/user/testGroup',
            method: 'post',
            handler: async (ctx) => {
                const res = await this.schApi.groups.test(ctx.request.body.group_name)

                ctx.body = JSON.stringify(res)
            },
            validate: {
                body: z.object({
                    group_name: z.string().transform(value => value.toLocaleLowerCase())
                })
            }
        })

        this.app.use(this.router.routes())

        this.hmacSecretKey = createHmac('sha256', 'WebAppData').update(this.token).digest()
    }

    async start() {
        // добавить кнопку web_app
        console.log('(tg) set web_app button...');
        const res = await this.tgbot.tf.telegram.setChatMenuButton({
            menuButton: {
                text: 'Настройки',
                type: 'web_app',
                web_app: {
                    url: this.webAppAddress,
                },
            },
        })
        if (!res) {

        }

        // запуск koa
        return this.app.listen(this.port, '0.0.0.0')
    }

    parseInitData(initData: string) {
        const params = new URLSearchParams(initData)

        const hash = params.get('hash')
        if (!hash) {
            return false
        }
        params.sort()
        params.delete('hash')

        const data_check_string = Array.from(params.entries(), ([key, value]) => `${key}=${value}`).join('\n')
        const rightHash = createHmac('sha256', this.hmacSecretKey).update(data_check_string).digest('hex')
        if (hash !== rightHash) {
            return false
        }

        const initDataParseRes = WebAppApi.initDataObj.safeParse(Object.fromEntries(params.entries()))
        if (!initDataParseRes.success) {
            console.error(initDataParseRes.error)
            return false
        }
        const { data } = initDataParseRes

        if ((Date.now() / 1000) - data.auth_date > (60 * 10)) {
            return false
        }

        const user = JSON.parse(initDataParseRes.data.user)
        const userParseRes = WebAppApi.webAppUser.safeParse(user)
        if (!userParseRes.success) {
            console.error(userParseRes.error)
            return false
        }

        const res = Object.assign(initDataParseRes.data, { user: userParseRes.data })

        return res
    }

    static initDataObj = z.object({
        query_id: z.string().optional(),
        user: z.string(),
        auth_date: z.coerce.number(),
        signature: z.string(),
    })

    static webAppUser = z.object({
        id: z.number(),
        first_name: z.string(),
        last_name: z.string().optional(),
        username: z.string().optional(),
    })

    static filterStringArr = z.string().array().optional().transform(arr => (arr && arr.length === 0) ? undefined : arr)

    static filtersObj = z.object({
        faculty: z.number().array().optional().transform(arr => (arr && arr.length === 0) ? undefined : arr),
        group_name: z.string().array().optional().transform(arr => (arr && arr.length === 0) ? undefined : arr),
        role: z.string().array().optional().transform(arr => (arr && arr.length === 0) ? undefined : arr),
        forced: z.boolean().optional(),
    })

    static requestParams = z.object({
        initData: z.string(),
        platform: z.union([z.literal(platformNames[0]), z.literal(platformNames[1])]),
    })
}

export type filterObj = z.infer<typeof WebAppApi.filtersObj>

type state = {
    initDataObj: z.infer<typeof WebAppApi.initDataObj>,
    user: z.infer<typeof WebAppApi.webAppUser>,
    platform: platforms,
}
