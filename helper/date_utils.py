
import calendar
import pytz
# from . import constance
from datetime import datetime, timedelta, date, time
from chinese_calendar import is_holiday, is_workday
from pymongo import MongoClient, DESCENDING, ASCENDING


def round_datetime(dt_str):
    dt = datetime.strptime(dt_str, '%Y-%m-%d %H:%M:%S.%f')
    timestamp = (dt - datetime(1970, 1, 1)).total_seconds()
    rounded_timestamp = round(timestamp / 0.5) * 0.5
    rounded_dt = datetime(1970, 1, 1) + timedelta(seconds=rounded_timestamp)
    return rounded_dt.strftime('%Y-%m-%d %H:%M:%S.%f')[:23]

def get_today_date_string():
    now = datetime.now(pytz.timezone("Asia/Shanghai"))
    return convert_date_to_str(now)


def convert_date_to_str(time, splitor = ""):
    date = datetime(time.year, time.month, time.day, 8)
    return date.strftime('%Y{}%m{}%d'.format(splitor, splitor))


def convert_date_to_time_str(time):
    return time.strftime('%Y%m%d%H%M%S')


def convert_str_to_date(date_str):
    if "-" in date_str:
        date_str = date_str.replace("-","")
    date = datetime(int(date_str[0:4]), int(date_str[4:6]), int(date_str[6:8]))
    return date


def is_work_day(date_str):
    return is_workday(convert_str_to_date(date_str))

def date_add_days(time, days):
    delta = timedelta(days=days)
    new_time = time + delta
    return new_time


def datestr_add_days(datestr, days, splitor = ""):
    time = convert_str_to_date(datestr)
    new_time = date_add_days(time, days)
    return convert_date_to_str(new_time, splitor)


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

def sec_diff(start, end):
    time_format = "%Y-%m-%d %H:%M:%S.%f"
    return  (datetime.strptime(end, time_format) - datetime.strptime(start, time_format)).total_seconds()

def min_diff(start, end):
    time_format = "%Y-%m-%d %H:%M:%S.%f"
    return round((datetime.strptime(end, time_format) - datetime.strptime(start, time_format)).total_seconds()/60, 1)

def get_kp_time_string(target_date = ""):
    now = datetime.now(pytz.timezone("Asia/Shanghai"))
    if target_date:
        date_str = target_date
    elif now.time() >= time(21, 0, 0):
        date_str = now.strftime('%Y-%m-%d')
    else:
        date_str = date_add_days(now, -1).strftime('%Y-%m-%d')
        
    return f"{date_str} 21:00:00.000"


if __name__ == "__main__":
    # dt_str = "2020-01-23 14:02:23.627"
    # rounded_dt_str = round_datetime(dt_str)
    # print(rounded_dt_str)
    print(get_kp_time_string())
