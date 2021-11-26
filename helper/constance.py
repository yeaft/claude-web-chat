from os import walk
import socket
import time
import click
import json
import calendar
import hmac
import hashlib
import base64
import urllib.parse
import requests
from datetime import datetime, timedelta, date
from statistics import mean, variance, stdev

from futurestimulate.utils import logger as log
from pymongo import MongoClient, DESCENDING, ASCENDING

requests.packages.urllib3.disable_warnings()
ONLINE = True if socket.gethostname() == "ali-dev01" else False
PROXIES = {'https': "socks5h://localhost:1080"}
# MONGODB_CONNECTION_STRING = "mongodb://localhost:27017" if socket.gethostname() in ['DESKTOP-ECBL64U', 'Tom-Surface', 'DESKTOP-LMT091I', 'vm172-31-0-3.ksc.com'] else "mongodb://120.92.210.196"
MONGODB_CONNECTION_STRING = "mongodb://localhost:27017"
# MONGODB_CONNECTION_STRING = "mongodb://120.92.119.90"

TREND_COL = MongoClient(MONGODB_CONNECTION_STRING).future.dayInfoMainTrend
UPLOAD_RECORD_COL = MongoClient(MONGODB_CONNECTION_STRING).future.uploadRecord
INFO_COL = MongoClient(MONGODB_CONNECTION_STRING).future.dayInfo
MAIN_COL = MongoClient(MONGODB_CONNECTION_STRING).future.dayInfoMain
SECOND_COL = MongoClient(MONGODB_CONNECTION_STRING).future.dayInfoSecond
WAVE_COL = MongoClient(MONGODB_CONNECTION_STRING).future.dayInfoMainWave
VERIFY_COL = MongoClient(MONGODB_CONNECTION_STRING).future.dayInfoMainVerify
TRADE_COL = MongoClient(MONGODB_CONNECTION_STRING).future.tradeMap
FINAL_COL = MongoClient(MONGODB_CONNECTION_STRING).future.finalVerify
FINAL_RESULT_COL = MongoClient(MONGODB_CONNECTION_STRING).future.finalVerifyResult
MERGED_FILTERS_COL = MongoClient(MONGODB_CONNECTION_STRING).future.mergedFilters
PREDICT_COL = MongoClient(MONGODB_CONNECTION_STRING).future.dailyPredict
DAILY_SUMMARY_COL = MongoClient(MONGODB_CONNECTION_STRING).future.dailySummary
CANDLE_FACTOR_EXPECT_COL = MongoClient(MONGODB_CONNECTION_STRING).future.candleFactorExpectBest
CANDLE_FACTOR_WIN_RATE_COL = MongoClient(MONGODB_CONNECTION_STRING).future.candleFactorWinRateBest
FACTOR_CHZ_MAP_COL = MongoClient(MONGODB_CONNECTION_STRING).future.factorChzMap
Min_MAX_MAP_COL = MongoClient(MONGODB_CONNECTION_STRING).future.minMaxMap
WAVE_RANGE_MAP_COL = MongoClient(MONGODB_CONNECTION_STRING).future.waveRangeMap
WAVE_STATUS_COL = MongoClient(MONGODB_CONNECTION_STRING).future.waveStatus
TICK_COL = MongoClient(MONGODB_CONNECTION_STRING).future.tick
TICK_SECOND_COL = MongoClient(MONGODB_CONNECTION_STRING).future.tickSecond
TICK5M_COL = MongoClient(MONGODB_CONNECTION_STRING).future.tick5m
TICK5MTEMP_COL = MongoClient(MONGODB_CONNECTION_STRING).future.tick5mTemp
TICK5Main_COL = MongoClient(MONGODB_CONNECTION_STRING).future.tick5Main
TRADE_COL = MongoClient(MONGODB_CONNECTION_STRING).future.trade
POSITION_COL = MongoClient(MONGODB_CONNECTION_STRING).future.position
SIMILAR_COL = MongoClient(MONGODB_CONNECTION_STRING).future.similar
SIMILAR_DAILY_COL = MongoClient(MONGODB_CONNECTION_STRING).future.similarDaily
SIMILAR_FACTOR_COL = MongoClient(MONGODB_CONNECTION_STRING).future.similarFactor
TRADE_INFO_COL = MongoClient(MONGODB_CONNECTION_STRING).future.tradeInfo
TRADE_INFO_HISTORY_COL = MongoClient(MONGODB_CONNECTION_STRING).future.tradeInfoHistory
GUIDE_COL = MongoClient(MONGODB_CONNECTION_STRING).future.guide

WORK_DATES = ["20206028", "20200927", "20201008"]
HOLIDAY_DATES = ["20200625", "20200626", "20200627", "20201001", "20201002", "20201003", "20201004", "20201005", "20201006", "20201007", "20210101", "20210103", "20210102",
                 "20210211", "20210212", "20210213", "20210214", "20210215", "20210216", "20210217", "20210403", "20210404", "20210405", "20210501", "20210502", "20210503", "20210504", "20210505", "20210612", "20210613", "20210614", "20210919", "20210920", "20210921", "20211001", "20211002", "20211003", "20211004", "20211005", "20211006", "20211007"]
LOGGER = log.get_logger()
NIGHT_TRADE_TYPES = ["a","ag","al","au","b","bu","c","cf","cs","cu","cy","eb","eg","fg","fu","hc","i","j","jm","l","m","ma","ni","nr","oi","p","pb","pg","pp","rb","rm","rr","ru","sa","sc","sn","sp","sr","ss","ta","v","y","zc","zn"]
CARE_TYPES = ["sf", "sm", "i", "ru", "ap", "ma", "zc", "pp", "wr", "jm", "hc", "l", "fg", "rm", "bu"]
# CARE_TYPES = ["sf", "sm", "i", "ru", "ap", "ma", "zc", "pp", "wr", "fb", "jm", "hc", "l", "fg", "rm", "bu"]
LARGE_DIFF_TYPES = ["fu", "i", "bu", "ma", "ni", "p", "jd", "nr", "ap", "j", "ru", "sc", "wr", "y", "cf", "rm", "b", "rb", "hc", "cj", "ta", "jd"]
CANDLE_TYPES = ['chz', 'abs']
OPT_TYPES = ['winRate', 'expect']
CANDLE_TYPES_TEST = ['abs']
MIN_MEANINGFUL_NUMBER = 60
MAX_PAST_ORDER = 30
MAX_NEXT_ORDER = 180
TIMES_MAP = {'ap': 13.0, 'cf': 12.0, 'cy': 12.0, 'fg': 12.0, 'jr': 35.0, 'lr': 15.0, 'ma': 12.0, 'oi': 12.0, 'pm': 35.0, 'ri': 35.0, 'rm': 12.0, 'rs': 50.0, 'sf': 12.0, 'sm': 12.0, 'sr': 12.0, 'ta': 12.0, 'wh': 23.0, 'zc': 12.0, 'a': 12.0, 'b': 12.0, 'bb': 50.0, 'c': 12.0, 'cs': 12.0, 'eg': 12.0, 'fb': 50.0,
             'i': 15.0, 'j': 13.0, 'jd': 12.0, 'jm': 13.0, 'l': 12.0, 'm': 12.0, 'p': 12.0, 'pp': 12.0, 'v': 12.0, 'y': 12.0, 'sc': 15.0, 'ag': 12.0, 'al': 13.0, 'au': 11.0, 'bu': 15.0, 'cu': 13.0, 'fu': 16.0, 'hc': 14.0, 'ni': 14.0, 'pb': 13.0, 'rb': 14.0, 'ru': 15.0, 'sn': 13.0, 'sp': 13.0, 'wr': 14.0, 'zn': 13.0}

CONTRACT_CODE_MAP = {'ic': '中证500指数', 'if': '沪深300指数', 'ih': '上证50指数', 't': '10年期国债', 'tf': '5年期国债', 'ts': '2年期国债', 'ap': '苹果', 'cf': '一号棉花', 'cy': '棉纱', 'fg': '玻璃', 'jr': '粳稻', 'lr': '晚籼稻', 'ma': '甲醇', 'oi': '菜油', 'pm': '普通小麦', 'ri': '早籼稻', 'rm': '菜籽粕', 'rs': '油菜籽', 'sf': '硅铁', 'sm': '锰硅', 'sr': '白糖', 'ta': '精对苯二甲', 'wh': '强麦', 'zc': '动力煤', 'a': '黄大豆1号', 'b': '黄大豆2号',
                     'bb': '胶合板', 'c': '玉米', 'cs': '玉米淀粉', 'fb': '纤维板', 'i': '铁矿石', 'j': '焦炭', 'jd': '鸡蛋', 'jm': '焦煤', 'l': '聚乙烯', 'm': '豆粕', 'p': '棕榈油', 'pp': '聚丙烯', 'v': '聚氯乙烯', 'y': '豆油', 'sc': '原油', 'ag': '白银', 'al': '铝', 'au': '黄金', 'bu': '石油沥青', 'cu': '铜', 'fu': '燃料油', 'hc': '热轧卷板', 'ni': '镍', 'pb': '铅', 'rb': '螺纹钢', 'ru': '天然橡胶', 'sn': '锡', 'sp': '纸浆期货', 'wr': '线材', 'zn': '锌', 'lh':'生猪'}
DING_URL_FORMAT = "https://oapi.dingtalk.com/robot/send?access_token=69b270ec15aae80e9fe16a5b8d1cee97093aa59fbfefa1b8bc4c2417314d116f&timestamp={}&sign={}"


TYPE_BIG_TREND = {
    "ru": "down",
    "ta": "down",
    "fu": "down",
    "fb": "up"
}
def convert_contract_code_to_name(code):
    return CONTRACT_CODE_MAP[code]


def list_all_file_names(dir_path, recursive=False):
    f = []
    for (dirpath, dirnames, filenames) in walk(dir_path):
        f.extend(filenames)
        if not recursive:
            break
#     LOGGER.info("Load file number {}".format(len(f)))
    return f


def convert_list_to_csv(name, data):
    name = name + "_" + str(time.time()) + ".csv"
    with open(name, "w") as f:
        if len(data) > 0:
            for d in data:
                f.write(d + "\n")


def echo_dics(datas, output_head=True, output_val=True, min_head_length=6, max_size=-1):
    if len(datas) < 1:
        return
    head = ""
    keys = []
    format_str = ""
    msg = ""
    for key, val in datas[0].items():
        if key == "_id":
            continue
        keys.append(str(key))

        length = max(len(str(val)), len(str(key)), min_head_length) if str(key) != "date" else 8
        format_str += "{:<" + str(length) + "} "

    format_str += "\n"
    if output_head:
        msg += format_str.format(*keys)
        click.echo(" " + format_str.format(*keys)[:-1])

    if output_val:
        cal_datas = datas[:] if max_size < 0 else datas[:max_size]
        for d in cal_datas:
            vals = []
            for key, val in d.items():
                if key == "_id":
                    continue
                vals.append(val)

            if (len(keys) == len(vals)):
                msg += format_str.format(*vals)
                click.echo(" " + format_str.format(*vals)[:-1])
            else:
                msg += (" ".join(list(str(x) for x in vals)) + "\n")
                click.echo(" " + " ".join(list(str(x) for x in vals)))
    
    return msg

def convert_dics_str(datas, output_head=True, output_val=True, min_head_length=6, max_size=-1):
    head = ""
    keys = []
    format_str = ""
    res = ""
    for key, val in datas[0].items():
        if key == "_id":
            continue
        keys.append(str(key))

        length = max(len(str(val)), len(str(key)), min_head_length) if str(key) != "date" else 8
        format_str += "{:<" + str(length) + "} "

    if output_head:
        res += format_str.format(*keys) + "\n"

    if output_val:
        cal_datas = datas[:] if max_size < 0 else datas[:max_size]
        for d in cal_datas:
            vals = []
            for key, val in d.items():
                if key == "_id":
                    continue
                vals.append(val)

            if (len(keys) == len(vals)):
                res += format_str.format(*vals) + "\n"
            else:
                res += "  ".join(list(str(x) for x in vals)) + "\n"
    
    return res


def echo_dic(data, output_head=True, output_val=True, min_head_length=6):
    head = ""
    keys = []
    format_str = ""
    for key, val in data.items():
        if key == "_id":
            continue
        keys.append(str(key))
        length = max(len(str(key)), min_head_length)
        format_str += "{:<" + str(length) + "} "

    if output_head:
        click.echo(format_str.format(*keys))

    vals = []
    for key, val in data.items():
        if key == "_id":
            continue
        vals.append(val)

    if output_val:
        click.echo(format_str.format(*vals))


def convert_dic_to_csv(name, data, replace_head_pair={}, is_new = True):
    name = name + ("_" + str(time.time()) + ".csv" if is_new else ".csv")
    with open(name, "w") as f:
        if len(data) > 0:
            head = ""
            for key, val in data[0].items():
                if key in replace_head_pair:
                    head += replace_head_pair[key] + ","
                else:
                    head += str(key) + ","
            head = head[:-1]
            f.write(head + "\n")

            for d in data:
                line = ""
                for key, val in d.items():
                    if isinstance(val, list):
                        line += "-".join(val) + ","
                    else:
                        line += str(val) + ","
                line = line[:-1]
                f.write(line + "\n")


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
    if date_str in WORK_DATES:
        return True
    if date_str in HOLIDAY_DATES:
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
        infos = list(MAIN_COL.find({"type":"ru", "date":{"$gte":datestr}}).sort("date", ASCENDING).limit(int(days)))
    else:
        infos = list(MAIN_COL.find({"type":"ru", "date":{"$lte":datestr}}).sort("date", DESCENDING).limit(int(-1 * days)))
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

def batch_process_time(current_count, batch_num, message):
    if current_count % batch_num == 0:
        LOGGER.info(message)


# curl 'https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx' \
#     - H 'Content-Type: application/json' \
#     - d '{"msgtype": "text","text": {"content": "我就是我, 是不一样的烟火"}}'
def send_ding_msg(msg, log_message = True):
    timestamp = str(round(time.time() * 1000))
    secret = 'SECc7fae5d4a91c7f001d6964edcb509ddea421a0ffe5521e8e72e70a1cf130f322'
    secret_enc = secret.encode('utf-8')
    string_to_sign = '{}\n{}'.format(timestamp, secret)
    string_to_sign_enc = string_to_sign.encode('utf-8')
    hmac_code = hmac.new(secret_enc, string_to_sign_enc, digestmod=hashlib.sha256).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(hmac_code))
    headers = {"Content-Type": "application/json"}
    r = requests.post(DING_URL_FORMAT.format(timestamp, sign), headers=headers, data=json.dumps(ding_msg(msg)))
    if log_message:
        LOGGER.info("Send message {}".format(msg))
        
    LOGGER.info("Send result {}".format(r.text))

def ding_msg(msg):
    return {
        "msgtype": "text",
        "text": {
            "content": msg
        },
        "at": {
            # "atMobiles": [
            #     "17600180726"
            # ],
            "isAtAll": False
        }
    }

def encode_str(string):
    index = 1
    res_string = ""
    chr_max = 10240
    str_len = len(string)
    if str_len < chr_max:
        rate = int(chr_max / str_len)
    else:
        rate = round(chr_max / str_len, 4)
    for c in string:
        offset = int(index * rate)
        res_string += chr(ord(c) + offset)
        index += 1
    return res_string

def decode_str(string):
    index = 1
    res_string = ""
    chr_max = 10240
    str_len = len(string)
    if str_len < chr_max:
        rate = int(chr_max / str_len)
    else:
        rate = round(chr_max / str_len, 4)
    for c in string:
        offset = int(index * rate)
        res_string += chr(ord(c) - offset)
        index += 1
    return res_string

def create_array_for_diction_element(diction, key):
    if key not in diction:
        diction[key] = []

def create_obj_for_diction_element(diction, key):
    if key not in diction:
        diction[key] = {}


def create_int_for_diction_element(diction, key):
    if key not in diction:
        diction[key] = 0


def calculate_statistic_value(array, prefix=""):
    if len(array) == 0:
        return {
        }
    avg = round(mean(array), 4) if len(array) > 1 else array[0]
    std = round(stdev(array), 4) if len(array) > 1 else 0
    return {
        prefix + "Avg": avg,
        prefix + "Max": round(max(array), 4),
        prefix + "Min": round(min(array), 4),
        prefix + "Stdev": std,
        prefix + "16%": round(avg + std, 4),
        prefix + "31%": round(avg + 0.5 * std, 4),
        prefix + "69%": round(avg - 0.5 * std, 4),
        prefix + "84%": round(avg - std, 4)
    }

def contract_type_times(contract_type):
    return (100 / TIMES_MAP[contract_type]) if contract_type in TIMES_MAP else 8

def active_contracts():
    contracts = list(x['type'] for x in list(MAIN_COL.find({"date": "20201210", "cjl": {"$gt": 50000}})))
    contracts.sort()
    return contracts

def is_number(s):
    try:
        float(s)  # for int, long and float
    except ValueError:
        return False

    return True

def convert_code_to_standard_code(info):
    date = info['date']
    contract_type = info['type'].replace("\t", "").replace(" ", "")
    code = info['code'].replace("\t","").replace(" ","")
    number_str = ""
    for c in code:
        if is_number(c):
            number_str += c
    suffix_num = number_str[-3:]
    if date[3:4] != suffix_num[0:1] and date[3:4] == "9":
        ten_year = str(int(date[2:3]) + 1)
    else:
        ten_year = date[2:3]
    real_code = contract_type.lower() + ten_year + number_str[-3:]
    return real_code


def read_data(path):
    datas = []
    count = 0
    with open(path, "r") as f:
        first_line = f.readline()
        keys = first_line.rstrip('\n').rstrip('\r').split(",")
        for last_line in f:
            data_arr = last_line.rstrip('\n').rstrip('\r').split(",")
            data = {}
            for i in range(0, len(keys)):
                if keys[i] == "resultPer":
                    data[keys[i]] = round(float(data_arr[i]), 4)
                else:
                    data[keys[i]] = data_arr[i]
            # if data['date'] >= "20150101":
            datas.append(data)    
            # count += 1
            # if count > 100000:
            #     break
    return datas

def read_data_with_num(path):
    datas = []
    loss_count = 0
    with open(path, "r") as f:
        first_line = f.readline()
        keys = first_line.rstrip('\n').rstrip('\r').split(",")
        for last_line in f:
            data_arr = last_line.rstrip('\n').rstrip('\r').split(",")
            data = {}
            if len(data_arr) != len(keys):
                loss_count += 1
                continue
            for i in range(0, len(keys)):
                if len(data_arr[i]) != 8 and data_arr[i][:2] != "20" and is_number(data_arr[i]):
                    data[keys[i]] = float(data_arr[i])
                else:
                    data[keys[i]] = data_arr[i]
            datas.append(data)

    if loss_count > 0:
        click.echo("Loss data {}".format(loss_count))
    return datas

if __name__ == "__main__":
    url = "http://120.92.119.90:12345/tradeInfo?encode=1"
    res = requests.get(url)
    click.echo(res.text)
    click.echo(decode_str(res.text))
    
