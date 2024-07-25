export function parseSyntaxStr(str: string) {
    // удалить из строки пробелы и разбить её на составляющие (слова и одиночные символы)
    const strParts = Array.from(str.matchAll(/(\w+|[(){}\[\]|])/g)).map(match => match[0])

    let rootpart = {
        group: true,
        required: true,
        wants: 'all',
        variants: [],
    } as part

    /** заполняемая в данный момент часть */
    let part = rootpart
    // стек. нужен для хранения и восстановления состояния при переходе на иной уровень вложенности
    let stack = [] as {
        part: part,
        tempVariant: anyPart[],
        lastBracketsType: number,
    }[]
    /** индекс типа последней открывающей скобки */
    let lastBracketsType = -1
    /** заполняемый в данный момент вариант списка частей текущей части */
    let tempVariant = [] as anyPart[]

    // для каждого куска строки
    for (let i = 0; i < strParts.length; i++) {
        const strPart = strParts[i]

        // если не спецсимвол
        if (strPart.length > 1) {
            tempVariant.push({
                group: false,
                str: strPart,
            })

            continue
        }

        /* при появлении открывающей скобки, выполняются действия, которые позволят сохранить состояние
        сборщика для текущей неоконченной части и перейти к заполнению вложенной части */
        let bracketsType = '({['.indexOf(strPart)
        if (bracketsType !== -1) {
            const subpart = {
                group: true,
                required: strPart !== '[',
                wants: ['all', 'some', 'all'][bracketsType] as wants,
                variants: [],
            } as part

            tempVariant.push(subpart)

            stack.push({
                part,
                tempVariant,
                lastBracketsType,
            })

            part = subpart
            tempVariant = []
            lastBracketsType = bracketsType

            continue
        }

        // завершение текущего и создание списка для нового варианта
        if (strPart === '|') {
            part.variants.push(tempVariant)
            tempVariant = []

            continue
        }

        /* при появлении закрывающей скобки выполняется завершение заполнения текущей части и возврат
        состояния неоконченной родительской части из стека */
        bracketsType = ')}]'.indexOf(strPart)
        if (bracketsType !== -1) {
            if (lastBracketsType !== bracketsType) {
                throw new Error(`ошибка в форматной строке. неправильная скобка:\n${wrapAndJoin(i)}`)
            }

            part.variants.push(tempVariant)

            const stackItem = stack.pop()
            if (!stackItem) {
                throw new Error(`ошибка в форматной строке. правая скобка на верхнем уровне:\n${wrapAndJoin(i)}`)
            }
            ({ part, tempVariant, lastBracketsType } = stackItem)
        }
    }
    part.variants.push(tempVariant)

    return rootpart


    function wrapAndJoin(i: number) {
        return strParts.map((part, pi) => (pi === i) ? `>${part}<` : part).join('')
    }
}

type anyPart = part | nonGroupPart

export type part = {
    group: true,
    required: boolean
    wants: wants,
    variants: (part | nonGroupPart)[][],
}

type nonGroupPart = {
    group: false,
    str: string,
}

type wants = 'all' | 'some'
