
import constance
import calendar

from datetime import datetime, timedelta, date
from pymongo import MongoClient, DESCENDING, ASCENDING

def get_today_date_string():
    now = datetime.now()
    return convert_date_to_str(now)


def convert_date_to_str(time):
    date = datetime(time.year, time.month, time.day, 8)
    return date.strftime('%Y%m%d')


def convert_date_to_time_str(time):
    return time.strftime('%Y%m%d%H%M%S')


def convert_str_to_date(date_str):
    date = datetime(int(date_str[0:4]), int(date_str[4:6]), int(date_str[6:8]))
    return date


def is_work_day(date_str):
    if date_str in constance.WORK_DATES:
        return True
    if date_str in constance.HOLIDAY_DATES:
        return False

    week_day = convert_str_to_date(date_str).weekday()
    if week_day < 5:
        return True
    else:
        return False


def date_add_days(time, days):
    delta = timedelta(days=days)
    new_time = time + delta
    return new_time


def datestr_add_days(datestr, days):
    time = convert_str_to_date(datestr)
    new_time = date_add_days(time, days)
    return convert_date_to_str(new_time)


def datestr_add_trade_days(datestr, days):
    if days > 0:
        infos = list(constance.MAIN_COL.find({"type": "ru", "date": {"$gte": datestr}}).sort(
            "date", ASCENDING).limit(int(days)))
    else:
        infos = list(constance.MAIN_COL.find({"type": "ru", "date": {"$lte": datestr}}).sort(
            "date", DESCENDING).limit(int(-1 * days)))
    if abs(days) == len(infos):
        return infos[-1]['date']
    else:
        return None


def date_add_months(time, months):
    month = time.month - 1 + months
    year = time.year + month // 12
    month = month % 12 + 1
    day = min(time.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def datestr_add_months(datestr, months):
    time = convert_str_to_date(datestr)
    new_time = date_add_months(time, months)
    return convert_date_to_str(new_time)


def day_diff(d1, d2):
    return (datetime.strptime(d1, '%Y%m%d') - datetime.strptime(d2, '%Y%m%d')).days
