import { Monday } from "./utils/monday.js";

export class SchApi {
    url: URL;

    constructor(link: string) {
        this.url = new URL(link);
    }

    async pairsGet(options: pairsGetTargetOptions & pairsGetDateOptions) {
        const rawres = await this.sendRequest<{ date: string, pairs: Pair[] }[]>({
            method: 'pairs.get',

            ...options,
            date: (options.week) ? String(new Monday(options.date)) : Monday.dateToIsoString(options.date),
            week: (options.week) ? '1' : '0',
        });

        return rawres.map(day => ({ date: new Date(day.date), pairs: day.pairs })) as Day[];
    }

    /**
     * метод предназанчен для получения расписания по многочисленным целям за раз
     * @param date дата, для которой должны быть получены пары
     * @param targets объект целей, ключи которого являются типами целей, а значения - списками целей
     * @returns объект с ключами - тиапми целей и значениями - картами результатов [цель, список пар]
     */
    async pairsBulkGet(date: Date, targets: { groupName: string[], query: string[] }) {
        const groupNameParams = targets.groupName.map(group => ['groupName[]', group] as [string, any])
        const queryParams = targets.query.map(query => ['query[]', query] as [string, any])

        const targetsEntries = groupNameParams.concat(queryParams)

        const isoDate = Monday.dateToIsoString(date)

        const resStorage = {
            groupName: new Map<string, Pair[]>(),
            query: new Map<string, Pair[]>(),
        }

        for (let i = 0; i < targetsEntries.length; i += SchApi.maxTargetsCount) {
            const params = targetsEntries.slice(i, i + SchApi.maxTargetsCount)
            params.push(['method', 'pairs.bulkGet'])
            params.push(['date', isoDate])

            const res = await this.sendRequest<{ [key in pairsBulkGetTargetTypes]?: { [key: string]: Pair[] } }>(params)

            const pairsByGroups = Object.entries(res.groupName ?? {})
            pairsByGroups.forEach(item => resStorage.groupName.set(item[0], item[1]))

            const pairsByQueries = Object.entries(res.query ?? {})
            pairsByQueries.forEach(item => resStorage.query.set(item[0], item[1]))
        }

        return resStorage
    }
    /** максимальное кол-во целей за раз для pairs.bulkGet */
    static maxTargetsCount = 100

    async teachersGet() {
        return await this.sendRequest<Teacher[]>({ method: 'teachers.get' });
    }

    async groupsGet() {
        return await this.sendRequest<{ faculty: string, groups: Group[] }[]>({ method: 'groups.get' });
    }

    async groupsTest(groupName: string) {
        return await this.sendRequest<{ available: boolean }>({ method: 'groups.test', groupName })
    }

    async updatesGet(monday: Monday) {
        const rawres = await this.sendRequest<{ name: string, display_name: string, short_display_name: string }[]>({
            method: 'updates.get',
            date: Monday.dateToIsoString(monday.date),
        });

        return rawres.map(item => ({ name: item.name, faculty_short: item.short_display_name, faculty: item.display_name }));
    }


    async sendRequest<returnType>(params: { method: methods, [key: string]: any } | [string, any][]) {
        let keyValueTuples = (params instanceof Array) ? params : Object.entries(params)

        const body = new FormData()

        for (const [key, value] of keyValueTuples) {
            if (!value) {
                continue
            }

            if (typeof value !== 'string' && value instanceof Array) {
                value.forEach(sub => body.append(key + '[]', String(sub)))
            } else {
                body.append(key, String(value));
            }
        }


        const resp = await fetch(this.url, { method: 'post', body });
        if (!resp.ok) {
            if (resp.body) {
                const text = await resp.text()
                try {
                    const res = JSON.parse(text)
                    console.error('содержимое ответа:', res)
                } catch(e) {
                    console.error('содержимое ответа:', text)
                }
            }

            throw new Error('Ошибка при выполнении запроса к API: ' + resp.status)
        }

        const res = await resp.json() as {
            ok: true,
            result: returnType,
        } | {
            ok: false,
            error: string,
        };

        if (!res.ok) {
            throw new Error(res.error);
        }

        return res.result;
    }
}

export type methods = 'pairs.get' | 'pairs.bulkGet' | 'teachers.get' | 'groups.get' | 'groups.test' | 'updates.get'
export type pairsBulkGetTargetTypes = 'groupName' | 'query'

export type pairsGetDateOptions = {
    date: Date,
    week: boolean,
};

export type pairsGetTargetOptions = (
    { groupId: number }
    | { groupName: string }
    | { teacherId: number }
    | { teacherLogin: string }
    | { query: string }
)

export type Pair = {
    text: string,
    num: number,
};

export type Day = {
    date: Date,
    pairs: Pair[],
};

export type Teacher = {
    id: number,
    name: string,
    url: string,
};

export type Group = {
    id: number,
    name: string,
};
