import { DB, dbUser, User } from "../db.js";
import { Formatter } from "./formatter.js";
import { actionsInfo, MsgAnalyser } from "./msgAnalyser/index.js";
import { texts } from "./texts.js";
import { Day, pairsGetDateOptions, pairsGetTargetOptions, SchApi } from "node-sch-api";
import { Monday } from "../utils/monday.js";
import { Logger } from "../logger.js";
import { platforms, PlatformSpecificBot } from "../platforms/index.js";

export class Bot {
	constructor(
		public msgAnalyser: MsgAnalyser,
		public schapi: SchApi,
		public db: DB,
		public logger: Logger,
	) { }

	async router(request: { text: string, from: string } | { start: true, from: string }, getUser: getUser) {
		let text = ''

		try {
			if ('start' in request) {
				// добавить пользователя в бд
				await getUser()

				return text = texts.shortHelp
			}

			const analyseRes = this.msgAnalyser.analyse(request.text)
			if (!analyseRes) {
				return text = '⚠️ Не удалось определить команду'
			}

			if (!analyseRes.allUsed) {
				text += `ℹ️ Выполненный запрос: ${analyseRes.chunks.filter(item => item.used).map(item => item.text).join(' ')}\n\n`
			}

			let handlerReturn: string
			switch (analyseRes.action) {
				case "cmd":
					handlerReturn = await this.cmdHandler(analyseRes.info as actionsInfo['cmd'], getUser)
					break

				case "sub":
					handlerReturn = await this.subHandler(analyseRes.info as actionsInfo['sub'], getUser)
					break

				case "search":
					handlerReturn = await this.searchHandler(analyseRes.info as actionsInfo['search'], getUser)
					break

				case "feedback":
					const { text } = analyseRes.info as actionsInfo['feedback']

					handlerReturn = await this.feedbackHandler(text, request.from)
					break
			}

			text += handlerReturn

			return text
		} catch (e) {
			console.error(e)
			this.logger.logToChat('бот. неизвестная ошибка', e)

			return text = '⚠️ Произошла неизвестная ошибка'
		} finally {
			this.logger.dumpRequest(
				JSON.stringify(request),
				text,
			)
		}
	}

	async cmdHandler(info: actionsInfo['cmd'], getUser: getUser): Promise<string> {
		switch (info.cmd) {
			case "bells":
				return texts.bells

			case "help":
				return texts.largeHelp

			case "format":
				const newFormat = await (await getUser()).switchFormat()
				return 'ℹ️ Формат обновлён\nСписок форматов:\n' + Formatter.makeTextListOfFormats(newFormat)

			case "mute":
				const newState = await (await getUser()).toggleMute()
				return 'ℹ️ Рассылка ' + ((newState) ? 'включена' : 'отключена')

			case "optout":
				await (await getUser()).wipe()
				return 'ℹ️ Настройки рассылок сброшены'

			case "stats":
				const updates = await this.schapi.updates.get(new Monday())
				return 'ℹ️ Расписание на текущую неделю доступно для следующих факультетов: ' + updates.map(item => item.faculty_short).join(', ')
		}
	}

	async subHandler(info: actionsInfo['sub'], getUser: getUser): Promise<string> {
		if (!info.target) {
			return '⚠️ Не удалось определить цель подписки. Проверьте формат группы (примеры верного формата: 430б, 1-23м, 123с, 123б-а) или укажите поисковый запрос (пример полной команды: подпиши поиск иванов)'
		}
		const { target } = info

		const user = await getUser()

		switch (target.type) {
			case "group":
				const { available } = await this.schapi.groups.test(target.value)

				await user.setGroup(target.value)
				return ((available) ? '' : '⚠️ Расписание для указанной группы ранее никогда не публиковалось. Проверьте правильность ввода\n\n') + makeText(user)

			case "query":
				const valRes = Bot.validateQuery(target.value)
				if (valRes !== true) {
					return valRes
				}

				await user.setQuery(target.value)
				return makeText(user)
		}

		function makeText(user: User) {
			const group = (user.group_name) ? `"${user.group_name}"` : 'нет подписки'
			const query = (user.query) ? `"${user.query}"` : 'нет подписки'
			const mailingStatus = (user.notify) ? 'включена' : 'отключена'
			return `ℹ️ Настройки подписки обновлены\nТекущие настройки:\n\nГруппа: ${group}\nПоисковый запрос: ${query}\nРассылка: ${mailingStatus}`
		}
	}
	static validateQuery(query: string) {
		if (query.length < 3) {
			return '⚠️ Поисковый запрос не может быть короче 3 символов'
		}

		let specialSymbolsCount = 0
		for (let i = 0; i < query.length; i++) {
			if (query[i] === '_' || query[i] === '%') {
				specialSymbolsCount++
			}
		}
		if (specialSymbolsCount / query.length > 0.25) {
			return '⚠️ Слишком общий запрос. Кол-во специальных символов не может быть больше четверти длины строки'
		}

		return true
	}

	async searchHandler(info: actionsInfo['search'], getUser: getUser): Promise<string> {
		let targets = {
			group: null as string | null,
			query: null as string | null,
		}

		if (info.target) {
			targets[info.target.type] = info.target.value
		}

		let text = ''
		if (targets.query?.match(MsgAnalyser.groupRegexp)) {
			text += '⚠️ Похоже, вы ищете расписание для группы. Если это так, попробуйте ещё раз, но без слова "поиск"\n\n'
		}

		const user = await getUser()

		// если цель запроса не была явно указана
		if (!(targets.group || targets.query)) {
			// если подписок также нет
			if (!(user.group_name || user.query)) {
				return '⚠️ Нет цели запроса. Укажите цель (группу или поисковый запрос), либо настройте подписку'
			}

			targets.group = user.group_name
			targets.query = user.query
		}

		const dateOptions: pairsGetDateOptions = {
			date: info.date,
			week: info.week,
		}

		const makeResponse = async (title: string, targetOptions: pairsGetTargetOptions) => {
			let text = `📌 ${title}\n\n`

			const daysInfo = await this.schapi.pairs.confirmableGet(Object.assign(targetOptions, dateOptions))
			if (!daysInfo.available) {
				return text + '⚠️ Расписание для соответствующей запросу недели недоступно'
			}
			let { days } = daysInfo

			if (dateOptions.week) {
				const monday = new Monday(dateOptions.date)

				// создать массив только из пустых дней
				let filledDays = new Array<Day>(6)

				// заполнить его имеющимися днями
				for (const day of days) {
					const dayIndex = day.date.getDay() - 1

					filledDays[dayIndex] = day
				}

				// заполнить окна днями без пар
				for (let i = 0; i < 6; i++) {
					const day = filledDays[i]

					if (day) {
						continue
					}

					const date = new Date(monday.date)
					date.setDate(monday.date.getDate() + i)

					filledDays[i] = {
						date,
						pairs: [],
					}
				}

				days = filledDays
			}

			return text + Formatter.formatDays(days, user.format) + '\n'
		}

		// добавить ответ по группе
		if (targets.group) {
			text += await makeResponse(`Расписание для группы ${targets.group}`, { groupName: targets.group })
		}

		// добавить ответ по поисковому запросу
		if (targets.query) {
			text += await makeResponse(`Расписание по запросу "${targets.query}"`, { query: targets.query })
		}

		return text
	}

	async feedbackHandler(text: string, sender: string): Promise<string> {
		if (text.length === 0) {
			return '⚠️ Чтобы отправить отзыв, нужно написать слово "отзыв" и после него текст, который вы хотите отправить'
		}

		this.logger.logToChat(`отзыв от ${sender}\n${text}`)

		return 'ℹ️ Отзыв отправлен'
	}

	async startMailing(sendFuncs: { [key in platforms]: PlatformSpecificBot['mailingSend'] }, nextday: boolean) {
		const date = new Date()
		if (nextday) {
			date.setDate(date.getDate() + 1)
		}

		const updates = await this.schapi.updates.get(new Monday(date))
		// не делать рассылку, если никакое расписание не доступно
		if (updates.length === 0) {
			return
		}

		const title = `${(nextday) ? '📗' : '📕'} Расписание занятий на ${(nextday) ? 'завтра' : 'сегодня'}`

		// получить список всех пользователей, у которых включена рассылка
		const users = await User.getAllSubs(this.db.pool)

		// подготовка и заполнение карт для хранения уникальных подписок и связанных с ними пользователей
		const subsOfGroup = new Map<string, dbUser[]>()
		const subsOfQuery = new Map<string, dbUser[]>()

		for (const user of users) {
			if (user.group_name) {
				const groupSub = subsOfGroup.get(user.group_name)
				if (groupSub) {
					groupSub.push(user)
				} else {
					subsOfGroup.set(user.group_name, [user])
				}
			}

			if (user.query) {
				const querySub = subsOfQuery.get(user.query)
				if (querySub) {
					querySub.push(user)
				} else {
					subsOfQuery.set(user.query, [user])
				}
			}
		}

		// запрос расписания по уникальным подпискам
		const pairsOfAllSubs = await this.schapi.pairs.confirmableBulkGet(
			date,
			{
				groupName: Array.from(subsOfGroup.keys()),
				query: Array.from(subsOfQuery.keys()),
			},
		)


		type pairsInfo = typeof pairsOfAllSubs['query'] extends Map<any, infer I> ? I : never
		type targetAndPairsInfoTuple = [string, pairsInfo]
		type userPairsInfo = { query: targetAndPairsInfoTuple, groupName: targetAndPairsInfoTuple }
		const bothSubsUsers = new Map<dbUser, userPairsInfo>()
		function getUserPairsInfo(dbuser: dbUser) {
			let t = bothSubsUsers.get(dbuser)
			if (!t) {
				t = { query: ['', { available: false }], groupName: ['', { available: false }] }
				bothSubsUsers.set(dbuser, t)
			}

			return t
		}

		// генерация и рассылка расписания
		const tasks: Promise<any>[] = []
		const errors: unknown[] = []
		const send = (user: dbUser, text: string) => sendFuncs[user.platform](user.id, text).catch(e => { errors.push(e) })
		const subtitleByGroupName = (groupName: string) => `📌 Группа ${groupName}:`
		const subtitleByQuery = (query: string) => `📌 Результаты поиска по "${query}":`

		for (const [group, pairsInfo] of pairsOfAllSubs.groupName) {
			const users = subsOfGroup.get(group) ?? []

			const cacheByFormat = new Array<string>(Formatter.presets.length)
			for (const user of users) {
				// если две подписки, то только занести данные
				if (user.query) {
					getUserPairsInfo(user).groupName = [group, pairsInfo]

					continue
				}

				if (!pairsInfo.available) {
					continue
				}

				// если рассылка на сегодня и расписание пустое
				if (!nextday && pairsInfo.pairs.length === 0) {
					continue
				}

				let text = cacheByFormat[user.format]
				if (!text) {
					text = `${title}\n\n${subtitleByGroupName(group)}\n${Formatter.formatPairs(pairsInfo.pairs, user.format)}`
					cacheByFormat[user.format] = text
				}

				tasks.push(send(user, text))
			}
		}

		for (const [query, pairsInfo] of pairsOfAllSubs.query) {
			const users = subsOfQuery.get(query) ?? []

			const cacheByFormat = new Array<string>(Formatter.presets.length)
			for (const user of users) {
				if (user.group_name) {
					getUserPairsInfo(user).query = [query, pairsInfo]

					continue
				}

				if (!pairsInfo.available) {
					// невозможно, т.к. для поиска расписание в апи помечается недоступным только если оно недоступно ни для одного факультета
					// такие случаи отсекаются в начале функции
					const warnText = 'расписание получено, но недоступно в подписках поиска'
					console.warn(warnText)
					errors.push(warnText)

					continue
				}

				// если рассылка на сегодня и расписание пустое
				if (!nextday && pairsInfo.pairs.length === 0) {
					continue
				}

				let text = cacheByFormat[user.format]
				if (!text) {
					text = `${title}\n\n${subtitleByQuery(query)}\n${Formatter.formatPairs(pairsInfo.pairs, user.format)}`
					cacheByFormat[user.format] = text
				}

				tasks.push(send(user, text))
			}
		}

		for (const [user, userPairsInfo] of bothSubsUsers) {
			const [groupName, groupNamePairsInfo] = userPairsInfo.groupName
			const [query, queryPairsInfo] = userPairsInfo.query

			const availByGroupName = groupNamePairsInfo.available
			const availByQuery = queryPairsInfo.available
			// если оба недоступны
			if (!availByGroupName && !availByQuery) {
				continue
			}

			const fullByGroupName = availByGroupName && groupNamePairsInfo.pairs.length > 0
			const fullByQuery = availByQuery && queryPairsInfo.pairs.length > 0
			// если рассылка на сегодня и вариантов лучше пустого расписания нет
			if (!nextday && !(fullByGroupName || fullByQuery)) {
				continue
			}

			const text = title + '\n\n' + makeText(groupNamePairsInfo, subtitleByGroupName(groupName)) + makeText(queryPairsInfo, subtitleByQuery(query))

			tasks.push(send(user, text))
			

			function makeText(pairsInfo: pairsInfo, subtitle: string) {
				let body = ''

				if (!pairsInfo.available) {
					body = '⚠️ Расписание недоступно'
				} else {
					body = Formatter.formatPairs(pairsInfo.pairs, user.format)
				}

				return `${subtitle}\n${body}\n`
			}
		}

		await Promise.allSettled(tasks)
		errors.forEach(error => console.error(error))
		if (errors.length > 0) {
			this.logger.logToChat('бот. рассылка. кол-во ошибок: ' + errors.length)
		}
	}
}

type getUser = () => Promise<User>
