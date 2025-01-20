import pg, { Pool } from 'pg';
import { Logger } from './logger.js';
import { platforms } from './platforms/index.js';
import { filterObj } from './platforms/tg_web_app_api.js';

export class DB {
    pool: pg.Pool

    constructor(connectionString: string, logger: Logger) {
        this.pool = new pg.Pool({
            connectionString,
            idleTimeoutMillis: 0,
        });

        this.pool.on('error', (e) => {
            console.error(e)
            logger.logToChat('БД pool', e)
        })
    }
}

export class User {
    private pool: pg.Pool
    public platform: platforms
    public id: number
    public notify: boolean
    public format: number
    public group_name: string | null
    public query: string | null
    public faculty_ids: number[] | null
    public can_run_mailing: boolean
    public wants_mailing: boolean
    public role: string | null

    private constructor(options: dbUser & {
        pool: pg.Pool,
    }) {
        this.pool = options.pool
        this.platform = options.platform
        this.id = options.id
        this.notify = options.notify
        this.format = options.format
        this.group_name = options.group_name ?? null
        this.query = options.query ?? null
        this.faculty_ids = options.faculty_ids ?? null
        this.can_run_mailing = options.can_run_mailing
        this.wants_mailing = options.wants_mailing
        this.role = options.role ?? null
    }

    static async make(pool: pg.Pool, id: number, platform: platforms) {
        let res = await pool.query<dbUser>('SELECT * FROM users WHERE id = $1::bigint and platform = $2::text LIMIT 1', [id, platform])
        let user = res.rows[0]

        if (!user) {
            // получить отдельного клиента
            const client = await pool.connect()
            // начать транзакцию
            await client.query('begin')

            // id для tg - 0, для vk - 1
            const platformId = (platform === 'tg') ? 0 : 1

            // попытаться получить исключительную блокировку в рамках транзакции
            // ключ для блокировки формируется из id пользователя и номера платформы, который записывается в диапазон с 63 по 59 разряды в id
            const lockRes = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(overlay(($1::bigint)::bit(64) PLACING ($2::int)::bit(4) FROM 2)::bigint) as ok', [id, platformId])
            const lockOk = lockRes.rows[0].ok

            if (lockOk) {
                // при удачном получении исключительной блокировки, добавить пользователя в бд и записать в результат добавленные данные
                res = await client.query<dbUser>('INSERT INTO users (id, platform) VALUES ($1::bigint, $2::text) RETURNING *', [id, platform])
            } else {
                // иначе ожидать завершения параллельного добавления с помощью ожидания разделяемой блокировки
                await client.query('SELECT pg_advisory_xact_lock_shared(overlay(($1::bigint)::bit(64) PLACING ($2::int)::bit(4) FROM 2)::bigint)', [id, platformId])

                // и по завершении получить добавленные параллельным запросом данные
                res = await client.query<dbUser>('SELECT * FROM users WHERE id = $1::bigint and platform = $2::text LIMIT 1', [id, platform])
            }

            // завершить транзакцию (также снимет блокировки)
            await client.query('commit')
            // вернуть клиента в пул
            client.release()

            user = res.rows[0]
        }

        return new User({ pool, ...user })
    }

    static async getAllSubs(pool: pg.Pool) {
        const res = await pool.query<dbUser>('SELECT * FROM users WHERE notify AND ((NOT group_name IS NULL) OR (NOT query IS null))')

        return res.rows
    }

    static async getByFilter(pool: pg.Pool, filter: filterObj) {
        const conds = User.makeConds(filter)

        const res = await pool.query<[id: number]>({
            text: `
                SELECT id
                FROM users
                WHERE platform = 'tg'
                    ${conds}
            `,
            rowMode: 'array',
        })

        return res.rows
    }

    static async countByFilter(pool: pg.Pool, filter: filterObj) {
        const conds = User.makeConds(filter)

        const res = await pool.query<{ count: number }>(`
            SELECT count(id) as count
            FROM users
            WHERE platform = 'tg'
                ${conds}
        `)

        return res.rows[0].count
    }

    private static makeConds(filter: filterObj) {
        const conds: string[] = []

        if (filter.faculty?.length) {
            conds.push(`AND faculty_ids && '{${filter.faculty.join(',')}}'`)
        }

        if (filter.group_name?.length) {
            const groups = filter.group_name.map(group => `'${group.replaceAll('\'', '')}'`)
            conds.push(`AND group_name = ANY (ARRAY [${groups.join(',')}])`)
        }

        if (filter.role?.length) {
            const roles = filter.role.map(role => `'${role.replaceAll('\'', '')}'`)
            conds.push(`AND role = ANY (ARRAY [${roles.join(',')}])`)
        }

        if (filter.forced !== true) {
            conds.push(`AND wants_mailing`)
        }

        return conds.join(' ')
    }

    async toggleMute() {
        const res = await this.pool.query<Pick<dbUser, 'notify'>>('UPDATE users SET notify = not notify WHERE id = $1::bigint AND platform = $2::text RETURNING notify', [this.id, this.platform])

        return res.rows[0].notify
    }

    async switchFormat() {
        const res = await this.pool.query<Pick<dbUser, 'format'>>('UPDATE users SET format = (format + 1) % 3 WHERE id = $1::bigint AND platform = $2::text RETURNING format', [this.id, this.platform])

        return res.rows[0].format
    }

    async setGroup(group: string) {
        await this.pool.query('UPDATE users SET group_name = $3::text WHERE id = $1::bigint AND platform = $2::text', [this.id, this.platform, group])
        this.group_name = group
    }

    async setQuery(query: string) {
        await this.pool.query('UPDATE users SET query = $3::text WHERE id = $1::bigint AND platform = $2::text', [this.id, this.platform, query])
        this.query = query
    }

    async wipe() {
        await this.pool.query('UPDATE users SET group_name = null, query = null WHERE id = $1::bigint AND platform = $2::text', [this.id, this.platform])
        this.group_name = null
        this.query = null
    }

    /** заменяет всю информацию пользователя переданной новой */
    async put(userObj: Omit<dbUser, 'id' | 'platform' | 'can_run_mailing'>) {
        const facIds = (userObj.faculty_ids?.length) ? `'{${userObj.faculty_ids.join(',')}}'` : null

        await this.pool.query(`UPDATE users SET (notify, format, group_name, query, faculty_ids, wants_mailing, role) = ($2, $3, $4, $5, ${facIds}, $6, $7) where id = $1`, [
            this.id,

            userObj.notify,
            userObj.format,
            userObj.group_name,

            userObj.query,
            userObj.wants_mailing,
            userObj.role,
        ])
    }

    static async drop(pool: Pool, id: number, platform: platforms) {
        return await pool.query<dbUser, [id: number, platform: platforms]>('DELETE FROM users WHERE id = $1::bigint and platform = $2::text RETURNING *', [id, platform])
    }
}

type ClassProperties<C> = {
    [Key in keyof C as C[Key] extends Function ? never : Key]: C[Key]
}
export type dbUser = ClassProperties<User>

type dbFaculty = {
    id: number,
    name: string,
    display_name: string,
    short_display_name: string,
}

type dbUserWithFac = dbUser & Omit<dbFaculty, 'id'>