import { Day, Pair } from "../api.js";

export class Formatter {
    static formatDays(days: Day[], presetIndex = 0) {
        if (days.length === 0) {
            return '❌ Пары не найдены';
        }

        let text = '';

        for (const day of days) {
            text += `📍 ${this.formatDate(day.date)}:\n${this.formatPairs(day.pairs, presetIndex)}\n`
        }

        return text;
    }

    static formatPairs(pairs: Pair[], presetIndex = 0) {
        if (pairs.length === 0) {
            return '❌ Пары не найдены\n';
        }

        const preset = this.presets[presetIndex]

        let text = ''
        let expectedNum = 1
        for (const pair of pairs) {
            if (preset.fillGaps) {
                // добавлять окна, пока счётчик не дойдёт до номера тек пары
                for (; expectedNum < pair.num; expectedNum++) {
                    text += preset.pairTextGenerator({ num: expectedNum, text: '-' }) + '\n'
                }
            }

            text += preset.pairTextGenerator(pair) + '\n'

            expectedNum++
        }

        return text
    }

    static makeTextListOfFormats(selection: number) {
        return Formatter.presets.map((v, i) => {
            let text = `${i + 1}: ${v.description}`;

            if (selection === i) {
                text += ' (текущий)'
            }

            return text
        }).join('\n')
    }


    /** возвращает дату в формате "ср 21.07.2024" */
    static formatDate(date: Date) {
        return `${this.localDayNames[date.getDay()]} ${date.toLocaleDateString()}`;
    }

    static localDayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    static nums = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

    static presets: Preset[] = [
        {
            description: 'По-умолчанию',
            pairTextGenerator: (pair) => `${this.nums[pair.num]} ${pair.text}`,
            fillGaps: false,
        },
        {
            description: 'С заполнением окон',
            pairTextGenerator: (pair) => `${this.nums[pair.num]} ${pair.text}`,
            fillGaps: true,
        },
        {
            description: 'Ранний',
            pairTextGenerator: (pair) => `🔘 ${pair.num}: ${pair.text}`,
            fillGaps: false,
        },
    ];
}

type Preset = {
    description: string,
    pairTextGenerator: (pair: Pair) => string,
    fillGaps: boolean,
};
