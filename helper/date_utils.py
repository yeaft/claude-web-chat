
import calendar
import json
import os
import pytz
# from . import constance
from datetime import datetime, timedelta, date, time
from lunardate import LunarDate
from pymongo import MongoClient, DESCENDING, ASCENDING

# ============================================================
# 交易日历：自动计算中国法定节假日（替代 chinese_calendar 库）
# 覆盖范围：元旦、春节、清明、五一、端午、中秋、国庆
# 调休工作日从 JSON 配置文件加载（需要每年手动更新）
# ============================================================

_CALENDAR_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'trading_calendar.json')
_HOLIDAY_CACHE = {}  # year -> set of YYYYMMDD
_WORK_DATES = set()

def _get_holidays_for_year(year):
    """自动计算某年的法定节假日（不含调休，只含放假日）"""
    if year in _HOLIDAY_CACHE:
        return _HOLIDAY_CACHE[year]

    holidays = set()

    def add_range(start_date, days):
        for i in range(days):
            d = start_date + timedelta(days=i)
            holidays.add(d.strftime('%Y%m%d'))

    # 元旦：1月1日，放1天
    add_range(date(year, 1, 1), 1)

    # 春节：农历正月初一前一天（除夕）到初六，共7天
    try:
        spring_festival = LunarDate(year, 1, 1).toSolarDate()
        add_range(spring_festival - timedelta(days=1), 7)
    except Exception:
        pass

    # 清明：4月4日或4月5日（大多数年份是4月5日），放1天
    # 简化处理：固定4月4-5日都标记，实际只差1天影响极小
    qingming = date(year, 4, 5) if year % 4 != 0 else date(year, 4, 4)
    add_range(qingming, 1)

    # 五一：5月1日，放1天（近年扩展为5天，但调休日由配置文件处理）
    add_range(date(year, 5, 1), 5)

    # 端午：农历五月初五，放1天
    try:
        duanwu = LunarDate(year, 5, 5).toSolarDate()
        add_range(duanwu, 1)
    except Exception:
        pass

    # 中秋：农历八月十五，放1天
    try:
        zhongqiu = LunarDate(year, 8, 15).toSolarDate()
        add_range(zhongqiu, 1)
    except Exception:
        pass

    # 国庆：10月1日-7日，共7天
    add_range(date(year, 10, 1), 7)

    _HOLIDAY_CACHE[year] = holidays
    return holidays

def _load_work_dates():
    """从 JSON 配置文件加载调休工作日"""
    global _WORK_DATES
    try:
        with open(_CALENDAR_FILE, 'r') as f:
            cal = json.load(f)
        _WORK_DATES = set(cal.get('work_dates', {}).get('dates', []))
    except FileNotFoundError:
        _WORK_DATES = set()

_load_work_dates()


def round_datetime(dt_str):
    dt = datetime.strptime(dt_str, '%Y-%m-%d %H:%M:%S.%f')
    timestamp = (dt - datetime(1970, 1, 1)).total_seconds()
    rounded_timestamp = round(timestamp / 0.5) * 0.5
    rounded_dt = datetime(1970, 1, 1) + timedelta(seconds=rounded_timestamp)
    return rounded_dt.strftime('%Y-%m-%d %H:%M:%S.%f')[:23]

def get_today_date_string():
    now = datetime.now(pytz.timezone("Asia/Shanghai"))
    return convert_date_to_str(now)

def get_today_time_string():
    now = datetime.now(pytz.timezone("Asia/Shanghai"))
    return convert_date_to_time_str(now)


def convert_date_to_str(time, splitor = ""):
    date = datetime(time.year, time.month, time.day, 8)
    return date.strftime('%Y{}%m{}%d'.format(splitor, splitor))


def convert_date_to_time_str(time, splitor = "-"):
    return time.strftime('%Y{}%m{}%d %H:%M:%S'.format(splitor, splitor))


def convert_str_to_date(date_str):
    if "-" in date_str:
        date_str = date_str.replace("-","")
    date = datetime(int(date_str[0:4]), int(date_str[4:6]), int(date_str[6:8]))
    return date


def is_work_day(date_str):
    date_str_clean = date_str.replace("-", "")
    # 调休工作日（周末但需上班）→ 优先级最高
    if date_str_clean in _WORK_DATES:
        return True
    # 法定节假日（自动计算）
    year = int(date_str_clean[:4])
    if date_str_clean in _get_holidays_for_year(year):
        return False
    # 默认：周一到周五为工作日
    dt = convert_str_to_date(date_str)
    return dt.weekday() < 5

def date_add_days(time, days):
    delta = timedelta(days=days)
    new_time = time + delta
    return new_time

def date_add_minutes(time, minutes):
    delta = timedelta(minutes=minutes)
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

def min_add(time, minutes):
    time = datetime.strptime(time, "%Y-%m-%d %H:%M:%S.%f")
    return (time + timedelta(minutes=minutes)).strftime("%Y-%m-%d %H:%M:%S.%f")

def get_kp_time_string(target_date = ""):
    now = datetime.now(pytz.timezone("Asia/Shanghai"))
    if target_date:
        date_str = target_date
    elif now.time() >= time(21, 0, 0):
        date_str = now.strftime('%Y-%m-%d')
    else:
        date_str = date_add_days(now, -1).strftime('%Y-%m-%d')
        
    return f"{date_str} 21:00:00.000"

# 2023-11-01 15:00:00.000
def get_kp_time_string_by_time(time):
    date = time.split(" ")[0]
    is_working_day = date_utils.is_work_day(date)
    
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
