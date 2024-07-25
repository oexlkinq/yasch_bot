import pg from 'pg';
import { Logger } from './logger.js';

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
        public id: number,
        public notify: boolean,
        public format: number,
        public group_name?: string,
        public query?: string,
    ) { }

    static async make(pool: pg.Pool, id: number) {
        let res = await pool.query<dbUser>('SELECT id, notify, format, group_name, query FROM users WHERE id = $1::bigint', [id])
        let user = res.rows[0]

        if (!user) {
            res = await pool.query<dbUser>('INSERT INTO users (id, notify, format, group_name, query) VALUES ($1::bigint, true, 0, null, null) RETURNING *', [id]);
            user = res.rows[0]
        }

        return new User(
            pool,
            user.id,
            user.notify,
            user.format,
            user.group_name,
            user.query,
        )
    }

    static async getAllSubs(pool: pg.Pool) {
        const res = await pool.query<dbUser>('SELECT id, notify, format, group_name, query FROM users WHERE notify AND ((NOT group_name IS NULL) OR (NOT query IS NULL))')

        return res.rows
    }

    async toggleMute() {
        const res = await this.pool.query<Pick<dbUser, 'notify'>>('UPDATE users SET notify = not notify WHERE id = $1::bigint RETURNING notify', [this.id])
        
        return res.rows[0].notify
    }
    
    async switchFormat() {
        const res = await this.pool.query<Pick<dbUser, 'format'>>('UPDATE users SET format = (format + 1) % 3 WHERE id = $1::bigint RETURNING format', [this.id])
        
        return res.rows[0].format
    }
    
    async setGroup(group: string) {
        await this.pool.query('UPDATE users SET group_name = $2::text WHERE id = $1::bigint', [this.id, group])
        this.group_name = group
    }
    
    async setQuery(query: string) {
        await this.pool.query('UPDATE users SET query = $2::text WHERE id = $1::bigint', [this.id, query])
        this.query = query
    }
    
    async wipe() {
        await this.pool.query('UPDATE users SET group_name = null, query = null WHERE id = $1::bigint', [this.id])
        this.group_name = undefined
        this.query = undefined
    }

    static async drop(pool: pg.Pool, user_id: number) {
        await pool.query('DELETE FROM users WHERE id = $1::bigint', [user_id])
    }
}

export type dbUser = {
    id: number,
    notify: boolean,
    format: number,
    group_name?: string,
    query?: string,
}
