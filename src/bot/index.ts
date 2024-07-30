import TelegramBot from "node-telegram-bot-api";
import { DB, dbUser, User } from "../db.js";
import { scheduleJob } from "node-schedule";
import { Formatter } from "./formatter.js";
import { actionsInfo, MsgAnalyser } from "./msgAnalyser/index.js";
import { texts } from "./texts.js";
import { pairsGetDateOptions, pairsGetTargetOptions, SchApi } from "./api.js";
import { Monday } from "../utils/monday.js";
import Bottleneck from 'bottleneck'
import { Logger } from "../logger.js";

export class Bot {
	private constructor(
		public tgbot: TelegramBot,
		public msgAnalyser: MsgAnalyser,
		public schapi: SchApi,
		public db: DB,
		public logger: Logger,
		public limiter: Bottleneck,
	) { }

	static async make(db: DB, schapi: SchApi, token: string, logger: Logger) {
		const tgbot = new TelegramBot(token)
		const msgAnalyser = new MsgAnalyser()
		const limiter = new Bottleneck({
			maxConcurrent: 30,
			reservoir: 30,
			reservoirRefreshAmount: 30,
			reservoirRefreshInterval: 1000,
		})

		return new Bot(tgbot, msgAnalyser, schapi, db, logger, limiter)
	}

	async start(skipStartupBurst = true) {
		// пропустить накопившиеся сообщения
		if (skipStartupBurst) {
			console.log('skip burst...');

			const updates = await this.tgbot.getUpdates({
				offset: -100,
				allowed_updates: ['message'],
			})

			updates.map(update => {
				const msg = update.message
				if (!msg) {
					return
				}

				console.log(`${msg.from?.username ?? msg.from?.first_name ?? '__nobody__'}: ${msg.text ?? '__nothing__'}`)
			})
		}

		// обновить список команд
		console.log('update commands...');
		await this.tgbot.setMyCommands([
			{
				command: 'start',
				description: 'Короткая справка + показать кнопки',
			}
		])

		// создание задач рассылки
		scheduleJob('0 7 * 1-6,9-12 1-6', async () => {
			try {
				await this.startMailing(new Date(), '📕 Расписание занятий на сегодня')
			} catch (e) {
				console.error(e)
				this.logger.logToChat('бот. рассылка', e)
			}
		});
		scheduleJob('0 19 * 1-6,9-12 0-5', async () => {
			try {
				const date = new Date()
				date.setDate(date.getDate() + 1)

				await this.startMailing(date, '📗 Расписание занятий на завтра')
			} catch (e) {
				console.error(e)
				this.logger.logToChat('бот. рассылка', e)
			}
		});

		// прикрепление обработчика сообщений
		this.tgbot.on('message', this.router.bind(this));

		// запуск обработки сообщений
		console.log('start polling...');
		return this.tgbot.startPolling({
			polling: true,
		})
	}

	async router(msg: TelegramBot.Message) {
		if (!msg.text) {
			return
		}

		const send = (text: string, options?: TelegramBot.SendMessageOptions) => {
			this.logger.dumpMsg(msg, text)

			return this.limiter.schedule(
				() => this.tgbot.sendMessage(
					msg.chat.id,
					text,
					Object.assign({ reply_markup: Bot.defaultKeyboard } as TelegramBot.SendMessageOptions, options),
				),
			)
		}

		try {
			let user: User | undefined
			const getUser = async () => user ?? (user = await User.make(this.db.pool, msg.chat.id))

			if (msg.text.startsWith('/start')) {
				return send(texts.shortHelp)
			}

			const analyseRes = this.msgAnalyser.analyse(msg.text)
			if (!analyseRes) {
				return await send('⚠️ Не удалось определить команду')
			}

			let text = ''
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
					handlerReturn = await this.feedbackHandler(text, msg.from)
					break
			}

			text += handlerReturn

			await send(text)
		} catch (e) {
			await send('⚠️ Произошла неизвестная ошибка')

			console.error(e)
			this.logger.logToChat('бот. неизвестная ошибка', e)
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
				const updates = await this.schapi.updatesGet(new Monday())
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
				const { available } = await this.schapi.groupsTest(target.value)

				await user.setGroup(target.value)
				return ((available) ? '' : '⚠️ Расписание для указанной группы ранее никогда не публиковалось\n\n') + makeText(user)

			case "query":
				await user.setQuery(target.value)
				return makeText(user)
		}

		function makeText(user: User) {
			const group = user.group_name ?? '-'
			const query = user.query ?? '-'
			return `ℹ️ Настройки рассылки обновлены\nТекущие настройки:\n\nГруппа: ${group}\nПоисковый запрос: ${query}`
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

			const days = await this.schapi.pairsGet(Object.assign(targetOptions, dateOptions))

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

	async feedbackHandler(text: string, from?: TelegramBot.User): Promise<string> {
		this.logger.logToChat(`отзыв от ${(from?.username) ? '@' + from.username : from?.first_name ?? '__nobody__'}\n${text}`)

		return 'ℹ️ Отзыв отправлен'
	}

	async startMailing(date: Date, title: string) {
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
		const pairsOfAllSubs = await this.schapi.pairsBulkGet(
			date,
			{
				groupName: Array.from(subsOfGroup.keys()),
				query: Array.from(subsOfQuery.keys()),
			},
		)

		// генерация и рассылка расписания
		const defferedMessages = new Map<number, string>()
		const tasks: Promise<any>[] = []
		const errors: unknown[] = []
		const limiter = new Bottleneck({
			maxConcurrent: 20,
			reservoir: 20,
			reservoirRefreshAmount: 20,
			reservoirRefreshInterval: 1000,
		})
		limiter.on('error', (e) => {
			console.error(e)
			this.logger.logToChat('бот. рассылка. событие error в limiter', e)
		})

		const limitedSend = limiter.wrap(async (user_id: number, text: string) => {
			try {
				await this.tgbot.sendMessage(user_id, text)
			} catch (e) {
				// https://github.com/yagop/node-telegram-bot-api/blob/master/doc/usage.md#error-handling
				if (e instanceof Object && 'code' in e && e.code === 'ETELEGRAM') {
					// @ts-ignore TODO
					const error_code = e.response?.body?.error_code
					if ([400, 403].includes(error_code)) {
						console.warn(`user ${user_id} was dropped`)
						User.drop(this.db.pool, user_id).catch(e => {
							console.error(e)
							this.logger.logToChat('бот. рассылка. удаление пользователя', e)
						})

						return
					}
				}

				errors.push(e)
			}
		})

		for (const [group, pairs] of pairsOfAllSubs.groupName) {
			if(pairs.length === 0){
				continue
			}

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
					defferedMessages.set(user.id, text)
				} else {
					// иначе отправить сразу же
					tasks.push(limitedSend(user.id, text))
				}
			}
		}

		for (const [query, pairs] of pairsOfAllSubs.query) {
			const users = subsOfQuery.get(query) ?? []

			if(pairs.length === 0){
				for(const user of users){
					const text = defferedMessages.get(user.id)

					if(text){
						tasks.push(limitedSend(user.id, text))
					}
				}

				continue
			}

			const cacheByFormat = new Array<string>(Formatter.presets.length)
			for (const user of users) {
				let text = cacheByFormat[user.format]
				if (!text) {
					text = `📌 Результаты поиска по "${query}":\n${Formatter.formatPairs(pairs, user.format)}`
					cacheByFormat[user.format] = text
				}

				const stMsgPart = defferedMessages.get(user.id)
				if (stMsgPart) {
					text = `${stMsgPart}\n${text}`
				} else {
					text = `${title}\n\n${text}`
				}

				tasks.push(limitedSend(user.id, text))
			}
		}

		await Promise.allSettled(tasks)
		await limiter.stop()
		errors.forEach(error => console.error(error))
		if(errors.length > 0){
			this.logger.logToChat('бот. рассылка. кол-во ошибок: ' + errors.length)
		}
	}

	static defaultKeyboard: TelegramBot.ReplyKeyboardMarkup = {
		keyboard: [
			[
				{ text: 'Сегодня' },
				{ text: 'Завтра' },
				{ text: 'Неделя' },
			],
			[
				{ text: 'Справка' },
				{ text: 'Звонки' },
				{ text: 'Файлы' },
			],
		],
		resize_keyboard: true,
		is_persistent: true,
	};
}

type getUser = () => Promise<User>
