import socket
import requests
from pymongo import MongoClient

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
REAL_TIME_TICK_COL = MongoClient(MONGODB_CONNECTION_STRING).future.realTimeTick
REAL_TIME_TICK_SECOND_COL = MongoClient(MONGODB_CONNECTION_STRING).future.realTimeTickSecond
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

MAIN_NAME = "主力连续"
SECOND_NAME = "次主力连续"

TYPE_BIG_TREND = {
    "ru": "down",
    "ta": "down",
    "fu": "down",
    "fb": "up"
}
    
