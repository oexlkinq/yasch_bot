import { parseSyntaxStr, part } from './syntaxStringParser.js'

type actionType = 'cmd' | 'sub' | 'search' | 'feedback'
type chunkType = 'cmd' | 'sub' | 'group' | 'query' | 'date' | 'week' | 'weekshift' | 'dayshift' | 'weekday' | 'feedback'

export class MsgAnalyser {
    chunksMap: Map<string, chunkDetectionRes<chunkType>>
    partsOfActions: { [key in actionType]: part }

    constructor() {
        // построить карту чанков
        this.chunksMap = new Map()

        for (let key in MsgAnalyser.aboutChunks) {
            const about = MsgAnalyser.aboutChunks[key as chunkType]

            // обработать 'match' - простые совпадения
            if ('match' in about) {
                about.match.map(match => {
                    let [aliases, res] = match

                    aliases.flatMap(alias => {
                        const me = []

                        if (alias.includes('+')) {
                            // преобразовать плюс в алиасе в сокращение
                            const parts = alias.split('+')

                            me.push(parts[0], parts.join(''))
                        } else {
                            me.push(alias)
                        }

                        // добавить транслит-варианты
                        return me.map(alias => MsgAnalyser.punto(alias)).concat(me)
                    }).forEach(alias => {
                        const dup = this.chunksMap.get(alias)
                        if (dup) {
                            return console.warn(`пропущен дублирующийся алиас: "${alias}" (action: "${key}" | "${dup.type}")`)
                        }

                        this.chunksMap.set(alias, {
                            type: key as chunkType,
                            value: res,
                        })
                    })

                })
            }
        }

        // спарсить синтаксис действий
        this.partsOfActions = {} as typeof this.partsOfActions

        for (let key in MsgAnalyser.aboutActions) {
            const item = MsgAnalyser.aboutActions[key as actionType]

            this.partsOfActions[key as actionType] = MsgAnalyser.parseSyntaxStr(item.syntax)
        }
    }

    analyse(msg: string) {
        const msgLC = msg.toLocaleLowerCase()
    
        let msgChunks = msgLC.split(' ')
        const chunksInfoByType = new Map<chunkType, { index: number, value: chunkValueTypes[chunkType] }>()
    
        for (let i = 0; i < msgChunks.length; i++) {
            const chunk = msgChunks[i]
    
            // попытаться определить чанк по карте
            let match = this.chunksMap.get(chunk)
    
            // попытаться определить чанк с помощью регулярок
            if (!match) {
                for (let key in MsgAnalyser.aboutChunks) {
                    const about = MsgAnalyser.aboutChunks[key as chunkType]
                    if ('REFmatch' in about) {
                        const res = about.REFmatch(chunk)
                        if (res === false) {
                            continue
                        }
    
                        match = {
                            type: key as chunkType,
                            value: res,
                        }
    
                        break
                    }
                }
            }
    
            // чанк неизвестен
            if (!match) {
                continue
            }
    
            // вызвать постобработку списка чанков, если есть обработчик
            const about = MsgAnalyser.aboutChunks[match.type]
            if ('chunksPostProcessing' in about) {
                const res = about.chunksPostProcessing(msgChunks, i)
    
                match.value = res.res
                msgChunks = res.chunks
            }
    
            chunksInfoByType.set(match.type, {
                index: i,
                value: match.value,
            })
        }
    
        for (let key in this.partsOfActions) {
            const type = key as actionType
            const part = this.partsOfActions[type]
    
            const cmpRes = compare(chunksInfoByType, part)
    
            if (!cmpRes.res) {
                continue
            }
    
            let usedChunks = [] as {
                index: number,
                type: chunkType,
                value: chunkValueTypes[chunkType],
            }[]
            for (const entry of chunksInfoByType) {
                const [type, chunkValueWithIndex] = entry
    
                if (!cmpRes.used.includes(type)) {
                    continue
                }
    
                usedChunks.push({
                    type,
                    ...chunkValueWithIndex,
                })
            }
    
            let chunks = msgChunks.map(text => ({ text, used: false }))
            usedChunks.forEach(item => chunks[item.index].used = true)
    
            return {
                action: type,
                info: MsgAnalyser.aboutActions[type].makeAction(usedChunks),
                chunks,
                allUsed: chunks.length === usedChunks.length,
            }
        }
    
        function compare(detectResults: typeof chunksInfoByType, part: part) {
            let res = false
    
            let usedDetectResults = [] as chunkType[]
            // проверять пока не найдётся совпадающий вариант
            for (let variant of part.variants) {
                usedDetectResults = []
    
                let badLeft = (part.wants === 'some') ? variant.length : 1
    
                // проверить присутствие каждой части
                for (let subpart of variant) {
                    let subpartRes = false
    
                    if (subpart.group) {
                        const compareInfo = compare(detectResults, subpart)
    
                        subpartRes = compareInfo.res
                        usedDetectResults = usedDetectResults.concat(compareInfo.used)
                    } else {
                        const detectRes = detectResults.get(subpart.str as chunkType)
    
                        if (detectRes) {
                            subpartRes = true
                            usedDetectResults.push(subpart.str as chunkType)
                        }
                    }
    
                    if (!subpartRes) {
                        badLeft--
    
                        if (badLeft === 0) {
                            break
                        }
                    }
                }
    
                // если вариант подошёл
                res = (badLeft > 0)
                if (res) {
                    break
                }
            }
    
            // если часть не необходима, то конечный результат будет зависеть только от проверки, иначе результат проверки не важен
            res = res || !part.required
    
            return {
                used: (res) ? usedDetectResults : [],
                res,
            }
        }
    }

    static parseSyntaxStr = parseSyntaxStr

    static aboutActions = {
        cmd: {
            syntax: 'cmd',
            makeAction: (chunks) => {
                return {
                    cmd: chunks[0].value as chunkValueTypes['cmd'],
                } as actionsInfo['cmd']
            }
        },
        sub: {
            syntax: 'sub [group | query]',
            makeAction: (chunks) => {
                let res: actionsInfo['sub'] = {}

                for (const chunk of chunks) {
                    switch (chunk.type) {
                        case 'group':
                            res.target = {
                                type: 'group',
                                value: chunk.value as chunkValueTypes['group'],
                            }
                            break

                        case 'query':
                            res.target = {
                                type: 'query',
                                value: chunk.value as chunkValueTypes['query'],
                            }
                            break

                        default:
                            break
                    }
                }

                return res
            },
        },
        search: {
            syntax: '{(dayshift | [weekshift] (weekday | week) | date [week]) (group | query)}',
            makeAction: (chunks) => {
                let res: actionsInfo['search'] = {
                    date: new Date(),
                    week: false,
                }

                for (const chunk of chunks) {
                    switch (chunk.type) {
                        case 'dayshift':
                            res.date.setDate(res.date.getDate() + (chunk.value as chunkValueTypes['dayshift']))
                            break

                        case 'weekshift':
                            res.date.setDate(res.date.getDate() + (chunk.value as chunkValueTypes['weekshift']) * 7)
                            break

                        case 'weekday':
                            res.date.setDate(res.date.getDate() - res.date.getDay() + (chunk.value as chunkValueTypes['weekday']))
                            break

                        case 'week':
                            res.week = chunk.value as chunkValueTypes['week']
                            break

                        case 'date':
                            res.date = chunk.value as chunkValueTypes['date']
                            break

                        case 'group':
                            res.target = {
                                type: 'group',
                                value: chunk.value as chunkValueTypes['group'],
                            }
                            break

                        case 'query':
                            res.target = {
                                type: 'query',
                                value: chunk.value as chunkValueTypes['query'],
                            }
                            break
                    }
                }

                return res
            },
        },
        feedback: {
            syntax: 'feedback',
            makeAction(chunks) {
                return {
                    text: chunks[0].value as chunkValueTypes['feedback'],
                } as actionsInfo['feedback']
            },
        },
    } as {
            [key in actionType]: {
                syntax: string,
                makeAction: (chunks: (chunkDetectionRes<chunkType> & { index: number })[]) => actionsInfo[key]
            }
        }

    static aboutChunks = {
        date: {
            REFmatch: (str: string) => {
                const re = /^(\d\d?)(?:\.(\d\d?)(?:\.(\d{2,4}))?)?$/

                const match = str.match(re)
                if (!match) {
                    return false
                }

                const [_, d, m, y] = match

                let date = new Date()
                date.setDate(+d)
                if (m) {
                    date.setMonth(+m - 1)
                }
                if (y) {
                    const fullYear = +y

                    date.setFullYear((fullYear < 2000) ? fullYear + 2000 : fullYear)
                }

                return date
            },
        },
        cmd: {
            match: [
                [['зв+онки', 'bells'], 'bells'],
                [['справка', 'help'], 'help'],
                [['формат', 'format'], 'format'],
                [['рассылка', 'mute'], 'mute'],
                [['забудь', 'wipe', 'optout'], 'optout'],
                [['файлы', 'stats'], 'stats'],
            ],
        },
        group: {
            REFmatch: (str: string) => {
                const match = str.match(MsgAnalyser.groupRegexp)
                if (!match) {
                    return false
                }

                return match[0]
            }
        },
        query: {
            match: [
                [['по+иск'], ''],
            ],

            chunksPostProcessing: (chunks, myIndex) => ({
                chunks: chunks.slice(0, myIndex + 1),
                res: chunks.slice(myIndex + 1).join(' '),
            }),
        },
        sub: {
            match: [
                [['под+пиши'], true],
            ],
        },
        week: {
            match: [
                [['нед+еля', 'неделю', 'неделе'], true],
            ],
        },
        weekshift: {
            match: [
                [['сл+едующий', 'следующая', 'следующее'], 1],
                [['пред+ыдущий', 'предыдущая', 'предыдущее'], -1],
            ],
        },
        dayshift: {
            match: [
                [['се+годня'], 0],
                [['за+втра'], 1],
                [['вч+ера'], -1],
            ],
        },
        weekday: {
            match: [
                [['пн', 'понедельник'], 1],
                [['вт+орник'], 2],
                [['ср+еда'], 3],
                [['чт', 'четверг'], 4],
                [['пт', 'пятница'], 5],
                [['сб', 'суббота'], 6],
            ],
        },
        feedback: {
            match: [
                [['отзыв'], '']
            ],

            chunksPostProcessing: (chunks, myIndex) => ({
                chunks: chunks.slice(0, myIndex + 1),
                res: chunks.slice(myIndex + 1).join(' '),
            }),
        },
    } satisfies aboutChunk

    static punto(str: string) {
        const dicts = {
            ru: `йцукенгшщзхъфывапролджэячсмитьбю`,
            en: `qwertyuiop[]asdfghjkl;'zxcvbnm,.`,
        }
    
        let from = dicts.ru
        let to = dicts.en
    
        if (dicts.en.includes(str[0])) {
            from = dicts.en
            to = dicts.ru
        }
    
        return Array.from(str).map(char => {
            const code = from.indexOf(char)
            if (code === -1) {
                return char
            }
    
            return to[code]
        }).join('')
    }

    static groupRegexp = /^\d-?\d\d[мбс](?:[-/][а-я0-9])?$/
}


export type actionsInfo = {
    cmd: { cmd: chunkValueTypes['cmd'] },
    sub: {
        target?: target,
    },
    search: {
        date: Date,
        week: boolean,
        target?: target,
    },
    feedback: { text: string },
}
type targetType = 'group' | 'query'
type target = {
    type: targetType,
    value: string,
}

type aboutChunk = {
    [key in chunkType]: ({
        match: matches<chunkValueTypes[key]>,
    } | {
        REFmatch: REFmatch<chunkValueTypes[key]>,
    } | {
        match: matches<chunkValueTypes[key]>,
        REFmatch: REFmatch<chunkValueTypes[key]>,
    }) & ({
        chunksPostProcessing: chunksPostProcessing<chunkValueTypes[key]>,
    } | {})
}

type chunkDetectionRes<targetChunkType extends chunkType> = {
    type: chunkType,
    value: chunkValueTypes[targetChunkType]
}


type chunkValueTypes = {
    date: Date,
    cmd: 'bells' | 'help' | 'format' | 'mute' | 'optout' | 'stats',
    group: string,
    query: string,
    sub: true,
    week: true,
    weekshift: number,
    dayshift: number,
    weekday: number,
    feedback: string,
}

type chunksPostProcessing<res> = (chunks: string[], yourIndex: number) => { chunks: string[], res: res }
type matches<res> = [string[], res][]
type REFmatch<res> = (str: string) => false | res

