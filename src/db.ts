import pg, { Pool } from 'pg';
import { Logger } from './logger.js';
import { platforms } from './platforms/index.js';

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
    private constructor(
        public pool: pg.Pool,
        public platform: platforms,
        public id: number,
        public notify: boolean,
        public format: number,
        public group_name?: string,
        public query?: string,
    ) { }

    static async make(pool: pg.Pool, id: number, platform: platforms) {
        let res = await pool.query<dbUser>('SELECT id, platform, notify, format, group_name, query FROM users WHERE id = $1::bigint and platform = $2::text', [id, platform])
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
                res = await client.query<dbUser>('INSERT INTO users (id, platform, notify, format, group_name, query) VALUES ($1::bigint, $2::text, true, 0, null, null) RETURNING *', [id, platform])
            } else {
                // иначе ожидать завершения параллельного добавления с помощью ожидания разделяемой блокировки
                await client.query('SELECT pg_advisory_xact_lock_shared(overlay(($1::bigint)::bit(64) PLACING ($2::int)::bit(4) FROM 2)::bigint)', [id, platformId])

                // и по завершении получить добавленные параллельным запросом данные
                res = await client.query<dbUser>('SELECT id, platform, notify, format, group_name, query FROM users WHERE id = $1::bigint and platform = $2::text', [id, platform])
            }

            // завершить транзакцию (также снимет блокировки)
            await client.query('commit')
            // вернуть клиента в пул
            client.release()

            user = res.rows[0]
        }

        return new User(
            pool,
            platform,
            user.id,
            user.notify,
            user.format,
            user.group_name,
            user.query,
        )
    }

    static async getAllSubs(pool: pg.Pool) {
        const res = await pool.query<dbUser>('SELECT id, platform, notify, format, group_name, query FROM users WHERE notify AND ((NOT group_name IS NULL) OR (NOT query IS null))')

        return res.rows
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
        this.group_name = undefined
        this.query = undefined
    }

    static async drop(pool: Pool, id: number, platform: platforms) {
        await pool.query('DELETE FROM users WHERE id = $1::bigint and platform = $2::text', [id, platform])
    }
}

export type dbUser = {
    id: number,
    platform: platforms,
    notify: boolean,
    format: number,
    group_name?: string,
    query?: string,
}
