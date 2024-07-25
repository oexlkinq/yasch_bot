type DateArgsArray = 
    []
    | [value: number | string | Date]
    | [year: number, monthIndex: number, day?: number, hours?: number, minutes?: number, seconds?: number, milliseconds?: number];

export class Monday{
    _date: Date;

    constructor(...args: DateArgsArray){
        // @ts-ignore
        const date = new Date(...args)
        
        this._date = Monday.setMonday(date);
    }

    get date(): Date{
        return this._date;
    }

    set date(value) {
        this._date = Monday.setMonday(value)
    }

    toString(){
        return Monday.dateToIsoString(this._date)
    }

    static dateToIsoString(date: Date) {
        const year = date.getFullYear()
        const month = String(date.getMonth() + 1).padStart(2, '0')
        const day = String(date.getDate()).padStart(2, '0')

        return `${year}-${month}-${day}`
    }

    static setMonday(date: Date) {
        date.setDate(date.getDate() - (date.getDay() + 6) % 7);
        date.setHours(0, -date.getTimezoneOffset(), 0, 0);

        return date
    }
}