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
				return text = texts.shortHelp
			}

			if (request.text.length > 100) {
				return text = '⚠️ Слишком длинный запрос'
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
				if (target.value.length < 3) {
					return '⚠️ Поисковый запрос не может быть короче 3 символов'
				}

				let specialSymbolsCount = 0
				for (let i = 0; i < target.value.length; i++) {
					if (target.value[i] === '_' || target.value[i] === '%') {
						specialSymbolsCount++
					}
				}
				if (specialSymbolsCount / target.value.length > 0.25) {
					return '⚠️ Слишком общий запрос. Кол-во специальных символов не может быть больше четверти длины строки'
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

	async searchHandler(info: actionsInfo['search'], getUser: getUser): Promise<string> {
		let targets = {
			group: undefined as string | undefined,
			query: undefined as string | undefined,
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

	async startMailing(sendFuncs: { [key in platforms]: PlatformSpecificBot['mailingSend'] }, date: Date, title: string) {
		const updates = await this.schapi.updates.get(new Monday(date))
		// не делать рассылку, если никакое расписание не доступно
		if (updates.length === 0) {
			return
		}

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

		// генерация и рассылка расписания
		const deferredMessages = new Map<number, string>()
		const tasks: Promise<any>[] = []
		const errors: unknown[] = []
		const send = (user: dbUser, text: string) => sendFuncs[user.platform](user.id, text).catch(e => { errors.push(e) })

		for (const [group, pairsInfo] of pairsOfAllSubs.groupName) {
			if (!pairsInfo.available) {
				continue
			}
			const { pairs } = pairsInfo

			const users = subsOfGroup.get(group) ?? []

			const cacheByFormat = new Array<string>(Formatter.presets.length)
			for (const user of users) {
				let text = cacheByFormat[user.format]
				if (!text) {
					text = `${title}\n\n📌 Группа ${group}:\n${Formatter.formatPairs(pairs, user.format)}`
					cacheByFormat[user.format] = text
				}

				// если есть ещё и подписка на поиск, то сохранить для отправки одним сообщением
				if (user.query) {
					deferredMessages.set(user.id, text)
				} else {
					// иначе отправить сразу же
					tasks.push(send(user, text))
				}
			}
		}

		for (const [query, pairsInfo] of pairsOfAllSubs.query) {
			const users = subsOfQuery.get(query) ?? []

			if (!pairsInfo.available) {
				for (const user of users) {
					const text = deferredMessages.get(user.id)

					if (text) {
						tasks.push(send(user, text))
					}
				}

				continue
			}
			const { pairs } = pairsInfo

			const cacheByFormat = new Array<string>(Formatter.presets.length)
			for (const user of users) {
				let text = cacheByFormat[user.format]
				if (!text) {
					text = `📌 Результаты поиска по "${query}":\n${Formatter.formatPairs(pairs, user.format)}`
					cacheByFormat[user.format] = text
				}

				const stMsgPart = deferredMessages.get(user.id)
				if (stMsgPart) {
					text = `${stMsgPart}\n${text}`
				} else {
					text = `${title}\n\n${text}`
				}

				tasks.push(send(user, text))
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
