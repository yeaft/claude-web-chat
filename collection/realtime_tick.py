import requests
import time
import math
import yaml
import socket
import click
import pytz
import sys
import os

# Add parent directory to Python path to import helper modules
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from analysis import realtime_abnormal_detector
from datetime import datetime, timedelta
from pymongo import MongoClient, DESCENDING, ASCENDING

DATA_URL = "https://hq.sinajs.cn/list="
DATA_5M_URL = "http://stock2.finance.sina.com.cn/futures/api/json.php/IndexService.getInnerFuturesMiniKLine5m?symbol="
START_TIMES = [["085959", "101500"], ["103000", "113000"], ["133000", "150000"], ["205955", "230000"]]
# 所有大宗商品品种候选池（排除金融期货）
ALL_COMMODITY_TYPES = [
    "rb", "hc", "i", "j", "jm",          # 黑色系
    "cu", "al", "zn", "ni", "sn", "pb",   # 有色金属
    "ag", "au",                            # 贵金属
    "sc", "fu", "bu", "lu",               # 能源
    "ma", "ta", "eg", "eb", "sa", "fg",   # 化工
    "l", "pp", "v", "pf",                 # 化工（塑料链）
    "ru", "sp", "ss",                     # 化工/其他
    "m", "y", "p", "a", "b", "c", "cs",  # 农产品（油脂豆类谷物）
    "rm", "oi", "cf", "sr",              # 农产品（软商品）
    "jd", "ap", "lh",                     # 农产品（鲜活）
    "sf", "sm",                           # 硅铁/锰硅
]
TOP_N = 10  # 采集成交量+持仓量排名前N的品种
CONTRACT_DP_MAP = {}

def get_top_n_types(n=TOP_N):
    """
    查询所有大宗商品品种的主力合约，按成交量和持仓量综合排名，返回 Top N 品种列表。
    排名规则：成交量排名 + 持仓量排名，取综合排名最靠前的 N 个。
    """
    current_date = datetime.now(pytz.timezone("Asia/Shanghai"))
    current_year = current_date.year % 100
    current_month = current_date.month

    all_results = []
    # 分批查询，每批最多 20 个品种（避免 URL 过长）
    batch_size = 10
    for batch_start in range(0, len(ALL_COMMODITY_TYPES), batch_size):
        batch_types = ALL_COMMODITY_TYPES[batch_start:batch_start + batch_size]
        all_codes = []
        code_to_type = {}

        for ct in batch_types:
            for i in range(6):
                target_year = current_year + (current_month + i - 1) // 12
                target_month = (current_month + i - 1) % 12 + 1
                code = f"{ct}{target_year:02d}{target_month:02d}"
                nf_code = f"nf_{code.upper()}"
                all_codes.append(nf_code)
                code_to_type[code.upper()] = ct

        url = DATA_URL + ",".join(all_codes)
        try:
            r = requests.get(url, headers={'Referer': 'http://vip.stock.finance.sina.com.cn/'}, proxies=constance.PROXIES) if constance.ONLINE else requests.get(url, headers={'Referer': 'http://vip.stock.finance.sina.com.cn/'})

            # 每个品种取成交量最大的合约
            type_best = {}
            for line in r.text.split("\n"):
                parts = line.split("=")
                if len(parts) > 1:
                    nor_code = parts[0].replace("var hq_str_nf_", "")
                    ct = code_to_type.get(nor_code)
                    if not ct:
                        continue
                    data_str = parts[1].replace('"', '').replace(';', '')
                    fields = data_str.split(",")
                    if len(fields) > 14:
                        cjl = int(float(fields[14])) if fields[14] else 0
                        ccl = int(float(fields[13])) if fields[13] else 0
                        if cjl > 0 and ccl > 0:
                            if ct not in type_best or cjl > type_best[ct]['cjl']:
                                type_best[ct] = {'type': ct, 'cjl': cjl, 'ccl': ccl}

            all_results.extend(type_best.values())
        except Exception as e:
            utils.log(f"Error querying batch {batch_types}: {e}")

    if not all_results:
        # 查询全部失败时使用默认品种
        utils.log("Warning: failed to query rankings, using defaults")
        return ["rb", "m", "ta", "ma", "sa", "hc", "i", "v", "fg", "p"]

    # 综合排名：成交量排名 + 持仓量排名，取总分最小的 Top N
    all_results.sort(key=lambda x: x['cjl'], reverse=True)
    for rank, item in enumerate(all_results):
        item['cjl_rank'] = rank

    all_results.sort(key=lambda x: x['ccl'], reverse=True)
    for rank, item in enumerate(all_results):
        item['ccl_rank'] = rank
        item['total_rank'] = item['cjl_rank'] + item['ccl_rank']

    all_results.sort(key=lambda x: x['total_rank'])
    top_types = [item['type'] for item in all_results[:n]]

    utils.log(f"Top {n} types by CJL+CCL ranking: {top_types}")
    for item in all_results[:n]:
        utils.log(f"  {item['type']:4s}  CJL: {item['cjl']:>10,}(#{item['cjl_rank']+1:2d})  CCL: {item['ccl']:>10,}(#{item['ccl_rank']+1:2d})  Total: #{item['total_rank']+2}")

    return top_types


def get_contract_map(monitor_types=None):
    """
    通过新浪期货API动态获取最新的主力和次主力合约代码
    返回包含types和collect_contracts的数据结构
    """
    if monitor_types is None:
        monitor_types = get_top_n_types()
    types = {}
    collect_contracts = []
    
    # 获取当前日期，用于生成合约代码
    current_date = datetime.now(pytz.timezone("Asia/Shanghai"))
    current_year = current_date.year % 100  # 获取年份后两位
    current_month = current_date.month
    
    for contract_type in monitor_types:
        # 生成当前日期附近的6个可能合约代码
        possible_codes = []
        for i in range(6):
            # 计算合约月份（从当前月份开始的未来合约）
            month_offset = i
            target_year = current_year + (current_month + month_offset - 1) // 12
            target_month = (current_month + month_offset - 1) % 12 + 1
            
            # 生成合约代码格式：类型YYMM
            code = f"{contract_type}{target_year:02d}{target_month:02d}"
            possible_codes.append(code)
        
        # 批量查询这些合约的数据
        normalised_codes = [f"nf_{code.upper()}" for code in possible_codes]
        url = DATA_URL + ",".join(normalised_codes)
        
        try:
            r = requests.get(url, headers={'Referer': 'http://vip.stock.finance.sina.com.cn/'}, proxies=constance.PROXIES) if constance.ONLINE else requests.get(url, headers={'Referer': 'http://vip.stock.finance.sina.com.cn/'})
            
            active_contracts = []
            for line in r.text.split("\n"):
                data_array = line.split("=")
                if len(data_array) > 1:
                    nor_code = data_array[0].replace("var hq_str_nf_", "")
                    code = nor_code.lower()
                    
                    data_str = data_array[1].replace("\"", "").replace(";", "")
                    str_s = data_str.split(",")
                    
                    # 检查是否有有效数据
                    if len(str_s) > 14:
                        cjl = int(float(str_s[14])) if str_s[14] else 0
                        ccl = int(float(str_s[13])) if str_s[13] else 0
                        
                        # 只保留有活跃交易的合约
                        if cjl > 0 and ccl > 0:
                            active_contracts.append({
                                'code': code,
                                'cjl': cjl,
                                'ccl': ccl
                            })
            
            # 按成交量降序排列，取前两个作为主力和次主力
            active_contracts.sort(key=lambda x: x['cjl'], reverse=True)
            
            if len(active_contracts) >= 2:
                main_contract = active_contracts[0]['code']
                second_contract = active_contracts[1]['code']
            elif len(active_contracts) == 1:
                main_contract = active_contracts[0]['code']
                # 如果没有次主力，使用下一个可能的合约
                second_contract = possible_codes[1] if len(possible_codes) > 1 else main_contract
            else:
                # 如果没有活跃合约，使用默认的前两个
                main_contract = possible_codes[0]
                second_contract = possible_codes[1] if len(possible_codes) > 1 else main_contract
            
            # 构建types数据结构
            types[contract_type] = {
                'code': main_contract,
                'secondCode': second_contract,
                'norCode': main_contract.upper(),
                'secondNorCode': second_contract.upper()
            }
            
            # 为所有监控品种添加到collect_contracts
            collect_contracts.append(main_contract)
                
        except Exception as e:
            utils.log(f"Error getting contract data for {contract_type}: {e}")
            # 出错时使用默认值
            default_main = f"{contract_type}{current_year:02d}{current_month:02d}"
            default_second = f"{contract_type}{current_year:02d}{(current_month % 12) + 1:02d}"
            types[contract_type] = {
                'code': default_main,
                'secondCode': default_second,
                'norCode': default_main.upper(),
                'secondNorCode': default_second.upper()
            }
            if contract_type in monitor_types:
                collect_contracts.append(default_main)
    
    return {
        "types": types,
        "collect_contracts": collect_contracts
    }

def convert_code_to_standard_code(source_code, contract):
    code_date = ''.join(filter(str.isdigit, source_code))
    code_normalized = contract + (code_date if len(code_date) > 3 else "2" + code_date)
    return code_normalized

def get_current_data(types, code_key = "norCode", current_time = ""):
    normalised_codes = list(("nf_" + v[code_key]) for k, v in types.items())
    if current_time == "":
        current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.000')
    url = DATA_URL + ",".join(normalised_codes)
    r = requests.get(url, headers={'Referer': 'http://vip.stock.finance.sina.com.cn/'}, proxies=constance.PROXIES) if constance.ONLINE else requests.get(url, headers={'Referer': 'http://vip.stock.finance.sina.com.cn/'})
    utils.log(r.text)
    # with open("/log.txt", "a") as f:
    #     f.write("{} \n".format(r.text))

    datas = []
    for line in r.text.split("\n"):
        data_array = line.split("=")
        if len(data_array) > 1:
            nor_code = data_array[0].replace("var hq_str_nf_", "")
            code = ""
            for k, v in types.items():
                if v[code_key] == nor_code:                    
                    code = v['secondCode'] if "second" in code_key else v['code']
                    t = k
                    break
                
            if code == "":
                continue

            data_str = data_array[1].replace("\"", "").replace(";", "")
            data = convert_str_to_ticker_data(current_time, t, code, data_str)
            if data['ccl'] == 0:
                continue
            datas.append(data)
    
    # with open("/data.txt", "a") as f:
    #     f.write("{} \n".format(datas))
    # echo_dics(datas, min_head_length=12)
    return datas,r.text

def is_end_with_5_sec():
    current_sec = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%S')[-1]
    return current_sec == "0" or current_sec == "5"

def initial_dp_data(monitor_contracts):
    # Contract map
    for c in monitor_contracts:
        if c in CONTRACT_DP_MAP:
            continue  # 已初始化过的品种不重复初始化
        CONTRACT_DP_MAP[c] = realtime_abnormal_detector.AbnormalDetector(past_x_hour=2, candidate_x_min=5,  precheck_x_min=30, check_column_name='ccl', precheck_min_slope_value=350, precheck_accept_slope_value=600, send_message=False, real_send_message=False)
        CONTRACT_DP_MAP[c].cjl_column_name = "cjlDiff"
        current_time = date_utils.date_add_days(datetime.now(), -10)
        current_time_str = date_utils.convert_date_to_str(current_time, "-")

        ticks = constance.REAL_TIME_TICK_COL.find({'type': c, 'date': {"$gte": current_time_str}}, sort=[('time', 1)])
        for t in ticks:
            CONTRACT_DP_MAP[c].process_new_data(t)

        CONTRACT_DP_MAP[c].send_message = True
        CONTRACT_DP_MAP[c].real_send_message = True
        utils.log("Initial dp data {} for {}".format(len(CONTRACT_DP_MAP[c].data), c))

    return

def collect_tick_data():

    contract_result = get_contract_map()
    types = contract_result["types"]
    collect_contracts = contract_result["collect_contracts"]
    monitor_contracts = list(types.keys())
    initial_dp_data(monitor_contracts)
    cols = {}
    cols["norCode"] = constance.REAL_TIME_TICK_COL
    cols["secondNorCode"] = constance.REAL_TIME_TICK_SECOND_COL
    last_datas = {}
    for key_code in ["norCode", "secondNorCode"]:
        last_one = cols[key_code].find_one({"type":"rb"}, sort=[("time", DESCENDING)])     
        last_datas[key_code] = list(cols[key_code].find({"time": last_one['time']})) if last_one != None else []    
    
    last_trade_status = False
    utils.log("Start collect realtime tick")
    utils.log("Types {0}".format(types))
    utils.log("Collect contracts: {0}".format(collect_contracts))
    while True:
        # align time
        while not is_end_with_5_sec():
            time.sleep(0.4)            
        
        current_trade_status = is_trading()
        if last_trade_status != current_trade_status:
            if not current_trade_status:
                # 非交易时段：重新查询排名，更新品种列表
                contract_result = get_contract_map()
                types = contract_result["types"]
                collect_contracts = contract_result["collect_contracts"]
                monitor_contracts = list(types.keys())
                initial_dp_data(monitor_contracts)
            elif current_trade_status:
                current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.000')
                if (current_time.split(" ")[1] >= "20:55:00.000" and current_time.split(" ")[1] <= "21:01:00.000") or (current_time.split(" ")[1] >= "08:55:00.000" and current_time.split(" ")[1] <= "09:01:00.000"):
                    msg = "{0}:\n监控品种({1}个):\n".format(current_time, len(types))
                    for t, v in types.items():
                        utils.log("Type {0}: code {1} secondCode {2}".format(t, v['code'], v['secondCode']))
                        msg += "{0} {1} {2}\n".format(v['code'], v['secondCode'], v['norCode'])
                    utils.send_ding_msg(msg)

            utils.log("Change trade status, current {0}".format("trading" if current_trade_status else "close"))
            last_trade_status = current_trade_status
            
        if current_trade_status:
            current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%Y-%m-%d %H:%M:%S.000')
            sec_results = {}
            for code_key in ["norCode", "secondNorCode"]:
            # get main tick info 
                current_datas, raw_text = get_current_data(types, code_key=code_key, current_time=current_time)
                # click.echo(types)
                # click.echo(raw_text)
                results = []
                for d in current_datas:
                    if d['cjl'] > 0 and d['ccl'] > 0:
                        if valid_data(d, last_datas[code_key]):
                            d['time'] = current_time
                            if code_key == "secondNorCode":
                                sec_results[d['type']] = d
                            results.append(d)
                        else:
                            click.echo("error data {}".format(d))
                            click.echo("error raw text {}".format(raw_text))
                
                cols[code_key].insert_many(results)
                last_datas[code_key] = current_datas

                # Prepare to send the abnormal information
                if code_key == "norCode":
                    for info in results:
                        if info['type'] in CONTRACT_DP_MAP:
                            try:
                                CONTRACT_DP_MAP[info['type']].process_new_data(info)
                            except Exception as e:
                                utils.log(e)
                
            # Update sum_ccl for real time tick
            # "norCode", "secondNorCode"
            for t in cols["norCode"].find({"time": current_time}):
                if t['type'] in sec_results:
                    sec_info = sec_results[t['type']]
                else:                
                    sec_info = cols["secondNorCode"].find_one({'type': t['type'], 'time': {"$lte": t['time']}}, sort=[('time', -1)])
                    
                if sec_info:
                    filter = {'type': t['type'], 'time': t['time']}
                    newvalues = {"$set": {'sum_ccl': t['ccl'] + sec_info['ccl']}}
                    cols["norCode"].update_one(filter, newvalues)
                else:
                    utils.log("No sec data {} {}".format(t['type'], t['time']))
                
        time.sleep(2)

# tick {"time" : "20200526 140750", "type" : "ag", "code" : "ag2012", "jkp" : 4195, "zgj" : 4319, "zdj" : 4180, "zxj" : 4299, "ccl" : 482064, "cjl" : 872750 }
#tick5m{"time" : "20210127 094000", "type" : "cu", "code" : "cu2102", "kpj" : "58800.000", "zgj" : "58800.000", "zdj" : "58790.000", "spj" : "58790.000", "cjl" : "263" }
def valid_data(data, last_datas):
    correct_data = True
    if len(last_datas) > 0:
        for l in last_datas:
            # if zxj has big change， then use last one
            if data['type'] == l['type']:
                if data['code'] == l['code'] and abs(data['zxj'] - l['zxj']) / l['zxj'] > 0.08:
                    correct_data = False
                    data['zxj'] = l['zxj']
                data['cjlDiff'] = (data['cjl'] - l['cjl']) if data['cjl'] >= l['cjl'] else data['cjl']
                break    
    return correct_data

def is_trading():
    current_time = datetime.now(pytz.timezone("Asia/Shanghai")).strftime('%H%M%S')
    today_str = date_utils.get_today_date_string()
    working = date_utils.is_work_day(today_str)
    if not working and current_time <= "013000":
        yesterdayday_str = date_utils.datestr_add_days(today_str, -1)       
        working = date_utils.is_work_day(yesterdayday_str)

    if working:
        for time_pair in START_TIMES:
            if current_time >= time_pair[0] and current_time <= time_pair[1]:
                return True
    
    return False

def convert_str_to_ticker_data(current_time, contract_type, code, data_str):
    str_s = data_str.split(",")
    data = {}
    data['time'] = ""
    data['type'] = contract_type
    data['code'] = code
    data['date'] = current_time.split(" ")[0]
    data['jkp'] = float(str_s[2]) if len(str_s) > 2 else 0
    data['zgj'] = float(str_s[3]) if len(str_s) > 3 else 0
    data['zdj'] = float(str_s[4]) if len(str_s) > 4 else 0
    data['zxj'] = float(str_s[8]) if len(str_s) > 8 else 0
    data['ccl'] = int(float(str_s[13])) if len(str_s) > 13 else 0
    data['cjl'] = int(float(str_s[14])) if len(str_s) > 14 else 0
    return data

def test_data():
    contract_result = get_contract_map()
    types = contract_result["types"]
    collect_contracts = contract_result["collect_contracts"]
    utils.log("Types: {}".format(types))
    utils.log("Collect contracts: {}".format(collect_contracts))
    for code_key in ["norCode", "secondNorCode"]:
        current_datas, raw_text = get_current_data(types, code_key)
        results = []
        for d in current_datas:
            if d['cjl'] > 0 and d['ccl'] > 0:
                results.append(d)
        utils.log("{}".format(raw_text))
        utils.log("----------------------------------------")
        utils.log("{}".format(results))

@click.command()
@click.option('--collect-type', '-c', default="s", help='collect data time span 5s  s|m')
def collect_data(collect_type):
    if collect_type == "s":
        collect_tick_data()
    else:
        test_data()

if __name__ == "__main__":
    collect_data()
    
    # Test
    # Initial data
    # initial_dp_data()
    # print(get_contract_map())
    # get_current_data({"p": {"norCode":"P2505"}})
