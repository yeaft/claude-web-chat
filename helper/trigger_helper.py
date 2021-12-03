import click
import math
import time
import json
import constance
import utils
import domain_utils
import date_utils
from pymongo import MongoClient, DESCENDING, ASCENDING
from statistics import mean, variance, stdev

# 1. 波动率(越高说明上下波动，越低说明一条直线，三个指标：周期，波动范围，波动范围可根据过往计算出最小最大影响值，波动频率)
# 2. 能量(单位时间的路程，能量越大，越有交易价值)
# 3. 走向背景(上涨，回调，二次上涨，二次回调)
# 4. 仓位情况(成交量，持仓量变化，只能描述激烈程度)
# 5. 日内背景(下跌连续性强于上涨)


def calculate_fluctuation_ratio(period, fluctuation_range, fluctuation_frequecy):
    if fluctuation_frequecy > 0 and fluctuation_range > 0 and period > 0:
        return math.log(fluctuation_frequecy, 1.2) *fluctuation_range * 100 / period
    else:
        return 0

def calculate_fluctuation_range(ticks, basic_frequency):
    # last_frequency = calculate_fluctuation_frequecy(ticks, fluctuation_range)['frequency']
    # max_diff = 9999999
    # final_fluctuation_range = fluctuation_range
    # final_frequency = {}
    # final_frequency['flucRange'] = 0
    accept_fluctuations = []
    # for f in range(40, 130, 5):
    for f in range(50, 55, 5):
        fluctuation_range = f / 10000
        fluctuation_obj = calculate_fluctuation_frequecy(ticks, fluctuation_range, need_peaks=True)
        current_frequency = fluctuation_obj['frequency']

        if fluctuation_obj == None:
            continue
        # if fluctuation_obj == None or current_frequency < basic_frequency:
        #     continue
        # 删选

        peak_diffs = list(abs(x['diffPer']) for x in fluctuation_obj['peakInfos'])
        min_diff = min(peak_diffs)
        avg_diff = mean(peak_diffs)
        # if avg_diff > 200 * fluctuation_range:
        fluctuation_obj['minDiff'] = min_diff
        fluctuation_obj['avgDiff'] = avg_diff
        fluctuation_obj['avgFlucRate'] = round(avg_diff / 100 / fluctuation_range, 4)
        fluctuation_obj['flucRange'] = fluctuation_range
        # click.echo("range: {}, frequency: {} min diff: {}, avg diff: {}".format(round(fluctuation_range, 4), current_frequency,  min_diff,  avg_diff))
        accept_fluctuations.append(fluctuation_obj)

        # 之前趋于均匀算法
        # current_diff = abs(current_frequency - last_frequency)
        # # click.echo("range: {}, frequency: {} diff: {}".format(round(fluctuation_range,4), current_frequency, round(current_diff / last_frequency, 4)))
        # if current_frequency < basic_frequency:
        #     break
        
        # if current_diff / last_frequency < max_diff:
        #     max_diff = current_diff / last_frequency 
        #     final_fluctuation_range = fluctuation_range
        #     final_frequency = fluctuation_obj
        
        # last_frequency = current_frequency


    if len(accept_fluctuations) == 0:
        return None

    accept_fluctuations.sort(key=lambda x: x['avgFlucRate'], reverse=True)
    return accept_fluctuations[0]

def calculate_fluctuation_frequecy(ticks, fluctuation_range, need_peaks = False, show_history = False):
    last_peak_price = ticks[0]['zxj']
    last_peak_type = "start"
    frequency = 0
    peaks = []
    up_fluctuations = []
    down_flucuations = []
    peak_infos = []
    last_peak_info = {}
    trigger_range = ""
    trigger_time = ""
    trigger_direction = ""
    up_infos = []
    down_infos = []
    code = ticks[0]['code']
    for t in ticks:
        if code != t['code']:
            click.echo("{} {}".format(code, t['code']))
            return None
        price = t['zxj']
        potensial_peak_type = "crest" if price - last_peak_price > 0 else "trough"
        peak_info = {
            "time": t['time'].replace(" ", "-"),
            "type": potensial_peak_type,
            "price": price,
            # "next": "↓" if potensial_peak_type == "crest" else "↑",
        }
        if last_peak_type != potensial_peak_type:
            if abs(price - last_peak_price) / last_peak_price >= fluctuation_range:
                # click.echo("{}, {}, {}, {}".format(t['time'], t['zxj'], last_peak_price, potensial_peak_type))
                peaks.append(last_peak_price)
                if len(peak_infos) > 0 and "price" in peak_infos[-1]:
                    last_peak_info['diff'] = last_peak_info['price'] - peak_infos[-1]['price']
                    last_peak_info['diffPer'] = round((last_peak_info['price'] - peak_infos[-1]['price']) * 100 / peak_infos[-1]['price'], 2)
                    if peak_infos[-1]['diff'] + last_peak_info['diff'] > 0:
                        last_peak_info['power'] = "up"
                    elif peak_infos[-1]['diff'] + last_peak_info['diff'] < 0:
                        last_peak_info['power'] = "down"
                    else: 
                        last_peak_info['power'] = peak_infos[-1]['power']
                else:
                    last_peak_info['diff'] = 0
                    last_peak_info['diffPer'] = 0
                    last_peak_info['power'] = "none"
                
                last_peak_info['triggerRange'] = trigger_range
                last_peak_info['Direc'] = trigger_direction
                last_peak_info['triggerTime'] = trigger_time
                last_peak_info['suffix'] = ""
                
                trigger_range = ""
                trigger_time = ""
                trigger_direction = ""
                if len(last_peak_info) > 1:
                    if len(peak_infos) > 1 and peak_infos[-1]['power'] != None:
                        if abs(last_peak_info['diffPer']) >= 3.5 * 100 * fluctuation_range:
                            suffix = "+"
                        elif abs(last_peak_info['diffPer']) < 1.5 * 100 * fluctuation_range:
                            suffix = "-"
                        else:
                            suffix = ""
                        # if last_peak_info['power'] != peak_infos[-1]['power']:
                        #     suffix = "+" if abs(last_peak_info['diffPer']) >= 0.9 else "-"
                        last_peak_info['suffix'] = suffix
                    peak_infos.append(last_peak_info)

                    if 'time' in last_peak_info and len(peak_infos) >2:
                        direction = "down" if last_peak_type == "crest" else "up"
                        trend_info = {
                            "time": peak_infos[-2]['time'],
                            "diff": peak_infos[-2]['diff'],
                            "per": peak_infos[-2]['diffPer'],
                            "direction": direction
                        }

                        if direction == "down":
                            down_infos.append(trend_info)
                        else:
                            up_infos.append(trend_info)
                            
                    
                last_peak_type = potensial_peak_type
                frequency += 1                
                last_peak_price = price                
                last_peak_info = peak_info

                if len(peak_infos) > 2:
                    if peak_infos[-1]['type'] == "trough" and peak_infos[-1]['power'] == "down":
                        trigger_range = "{}-{}".format(price, peak_infos[-2]['price'])
                        trigger_direction = "↓"
                        trigger_time = t['time'].replace(" ", "-")
                    elif peak_infos[-1]['type'] == "crest" and peak_infos[-1]['power'] == "up":
                        trigger_range = "{}-{}".format(price, peak_infos[-2]['price'])
                        trigger_direction = "↑"
                        trigger_time = t['time'].replace(" ", "-")
        else:
            last_peak_price = price
            last_peak_info = peak_info

    if show_history:
        for i in peak_infos:
            i['power'] = i['power'] + i['suffix']
            del i['suffix']
        utils.echo_dics(peak_infos[1:])
        utils.echo_dics(up_infos)
        up_statistic_info = domain_utils.calculate_statistic_value(list(x['diff'] for x in up_infos if x['diff'] > 0))
        utils.echo_dic(up_statistic_info)
        utils.echo_dics(down_infos)
        down_statistic_info = domain_utils.calculate_statistic_value(
            list(x['diff'] for x in down_infos))
        utils.echo_dic(down_statistic_info)
    
    if need_peaks:
        res = {
            "frequency": frequency,
            "peakInfos": list(x for x in peak_infos if x['diff'] != 0)
        }
    else:
        res = {
            "frequency": frequency
        }
    # if len(peaks) > 2:
    #     last_peak_price = peaks[0]
    #     for p in peaks[1:]:
    #         if p - last_peak_price > 0:
    #             up_fluctuations.append((p - last_peak_price) * 100 / last_peak_price)
    #         else:
    #             down_flucuations.append((last_peak_price - p) * 100 / last_peak_price)
            
    #         last_peak_price = p

    #     # up_avg = sum(up_fluctuations) / len(up_fluctuations) if len(up_fluctuations) > 0 else 0
    #     # up_stdev = stdev(up_fluctuations) if len(up_fluctuations) > 1 else 0
    #     # down_avg = sum(down_flucuations) / len(down_flucuations) if len(down_flucuations) > 0 else 0
    #     # down_stdev = stdev(down_flucuations) if len(down_flucuations) > 1 else 0
    #     up_statistic = calculate_statistic_value(up_fluctuations, "up")
    #     down_statistic = calculate_statistic_value(down_flucuations, "down")

    #     res.update(up_statistic)
    #     res.update(down_statistic)
    return res

def statistic_peaks(contracts):
    infos = []
    days = len(list(constance.MAIN_COL.find({"type":contracts[0], "date":{"$gte":"20210104", "$lte":"20210226"}})))
    for contract in contracts:
        file_name = 'fluctuation_peaks_{}_{}_{}.json'.format(contract, "20210104", "20210226")
        with open(file_name) as json_file:
            fluctuation_peaks = json.load(json_file)
        
        sub_infos = []
        for fluctuation, peaks in fluctuation_peaks.items():
            datas = peaks[1:]
            change_levels = list(x['changeLevel'] for x in datas if "changeLevel" in x)
            statistics = domain_utils.calculate_statistic_value(change_levels)
            info = {
                "contract": contract,
                "fluctuation": fluctuation,
                "count": len(datas),
                "appPer": round(len(datas) / days, 2),
            }
            info.update(statistics)
            infos.append(info)
        
        sub_infos.sort(key=lambda x: x['Stdev'])
        infos.extend(sub_infos[:3])
    
    infos.sort(key=lambda x: x['Stdev'])
    utils.echo_dics(infos)

def statistic_peaks_v2(contracts):
    infos = []
    for contract in contracts:
        file_name = 'fluctuation_peaks_{}_all.json'.format(contract)
        with open(file_name) as json_file:
            all_peaks = json.load(json_file)

        for code, fluctuation_peaks in all_peaks.items():
            sub_infos = []
            for fluctuation, peaks in fluctuation_peaks.items():
                datas = peaks[1:]
                if len(datas) == 0:
                    continue
                change_levels = list(x['changeLevel'] for x in datas if "changeLevel" in x)
                statistics = domain_utils.calculate_statistic_value(change_levels)
                days = len(list(constance.MAIN_COL.find({"code":code, "date":{"$gte":"20170101", "$lte":"20210226"}})))
                appPer = round(len(datas) / days, 2) if days > 0 else -1
                info = {
                    "contract": contract,
                    "code": code,
                    "fluctuation": fluctuation,
                    "count": len(datas),
                    "appPer": appPer
                }
                info.update(statistics)
                infos.append(info)

            sub_infos.sort(key=lambda x: x['Stdev'])
            # infos.extend(sub_infos[:3])

    infos.sort(key=lambda x: x['Stdev'])
    utils.convert_dic_to_csv("fluctuation", infos)
    # echo_dics(infos)
    

def calculate_fluctuation_ratio_by_types(contracts, end_date, period):
    start_date = date_utils.datestr_add_trade_days(end_date, -1 * (period + 1))
    basic_frequency = period * 2
    start_time = "{} 210000.000".format(start_date)
    end_time = "{} 150000.000".format(end_date)    
    results = []
    click.echo("Start time {}, end time {} period {}".format(start_time, end_time, period))
    for contract in contracts:
        process_start_time = time.time()
        code = constance.MAIN_COL.find_one({"type":contract, "date":start_date})['code']
        tick_main_col = MongoClient(
            constance.MONGODB_CONNECTION_STRING).future["tick_{}_main".format(contract)]
        ticks = list(tick_main_col.find({"code": code, "time": {"$gte": start_time, "$lte": end_time}}).sort("time", ASCENDING))
        if len(ticks) == 0:
            continue
        fluctuation_info = calculate_fluctuation_range(ticks, basic_frequency)
        if fluctuation_info == None:
            click.echo("{} has no fluctuation info".format(contract))
            continue

        # ratio = calculate_fluctuation_ratio(period, fluctuation_info['flucRange'], fluctuation_info['frequency'])
        # energy = calculate_energy(ticks)
        res = {}
        res['type'] = contract
        res['date'] = end_date
        res['period'] = period        
        res['flucRange%'] = 0
        # res['ratio'] = round(ratio, 4)
        # res['energy'] = round(energy, 4)
        res.update(fluctuation_info)        
        res['flucRange%'] = round(res['flucRange'] * 100, 3)
        del res['flucRange']
        del res['peakInfos']
        results.append(res)
        click.echo("process {} using {}s".format(contract, round(time.time()- process_start_time, 2)))
        # click.echo("{}, {}, {}, {}, {}, {}".format(period, fluctuation_range, frequency, ratio))

    return results

def calculate_energy(ticks):
    diffs = []
    l_t = ticks[0]
    for i in range(1,len(ticks)):
        t = ticks[i]
        if t['zxj'] == t['jkp'] and t['zgj'] == t['zdj'] and t['zxj'] == t['zgj']:
            continue
        
        diff = abs(t['zxj'] - l_t['zxj']) * 100 / l_t['zxj']
        diffs.append(diff)
        l_t = t
    return mean(diffs)

def check_daily_fluction(contract, start_time, end_time, fluction_rate):
    tick_main_col = MongoClient(constance.MONGODB_CONNECTION_STRING).future["tick_{}_main".format(contract)]
    ticks = list(tick_main_col.find({"time": {"$gte": start_time, "$lte": end_time}}).sort("time", ASCENDING))
    if len(ticks) > 0:
        obj = calculate_fluctuation_frequecy(ticks, fluction_rate, True)
        utils.echo_dic(obj)

def get_types_daily_fluction():
    # period = 5
    # dates = list(x['date'] for x in list(MAIN_COL.find({"type":"ru", "date": {"$gte":"20210101"}})))
    # results = []
    # click.echo("Dates {}".format(len(dates)))
    # for d in dates:
    #     results.extend(calculate_fluctuation_ratio_by_types(["ru"], d, period))

    # echo_dics(results)
    return None

# 1. open range
# 2. loss cut = open max range
# 3. win cut：
    # a. direction change
    # b. next peak?
    # c. big peak?
def analysis(end_date, types, period = 5):
    if types == "":
        types = domain_utils.active_contracts()
    else:
        types = types.split(",")

    results = []
    if end_date != "":
        dates = list(x['date'] for x in constance.MAIN_COL.find({"type": types[0], "date":{"$gte":end_date}}))
    for d in dates:
        res = calculate_fluctuation_ratio_by_types(types, d, period)
        results.extend(res)
    utils.echo_dics(results)
    return results

def check_tick_data(types):
    start_time = time.time()
    missing_infos = []
    for contract_type in types:
        last_date = ""       
        count = 0
        tick_main_col = MongoClient(constance.MONGODB_CONNECTION_STRING).future["tick_{}_main".format(contract_type)]
        for tick in list(tick_main_col.find().sort("time",ASCENDING)):
            date = tick["time"][:8]            
            if last_date != date:
                info = {}
                info['type'] = contract_type
                info['date'] = last_date
                info['count'] = count
                missing_infos.append(info)
                last_date = date
                count = 0
            else:
                count += 1
        if count > 0:
            info = {}
            info[last_date] = count
            missing_infos.append(info)
    
    click.echo("Finish using {}s".format(round(time.time() - start_time, 2)))
    utils.convert_dic_to_csv("tick_info", missing_infos)

@click.command()
@click.option('--action', '-a', default='a', help='new Tip')
@click.option('--date', '-d', default="20210111", help='date')
@click.option('--start-time', '-st', default="20210111 210000.500", help='date')
@click.option('--end-time', '-et', default="20210226 150000.500", help='date')
@click.option('--code', '-c', default="ru2105", help='')
@click.option('--rate', '-r', type=float, help='')
@click.option('--types', '-t', default="rb", help='')
def action(action, date, start_time, end_time, code, rate, types):
    if action == "c":
        check_daily_fluction(types.split(",")[0], start_time, end_time, rate)
    elif action == "a":
        analysis(date, types)

def get_good_types():    
    file_name = 'best_type_factors_intraday_2.json'
    with open(file_name) as json_file:
        factors = json.load(json_file)

    result = []
    for k, v in factors.items():
        v_arr = v.split("_")
        per = float(v_arr[1])
        if per > 1.12:
            contract = k.split(":")[0]
            result.append({
                "contract": contract,
                "num": float(v_arr[0]),
                "per": per,
                "result": float(v_arr[2]),
            })

    result.sort(key=lambda x: x['result'], reverse=True)
    utils.echo_dics(result)


if __name__ == "__main__":
    # check_tick_data(["rb"])
    # action()
    # types = ["rb", "ru", "i", "ma", "sp", "ta", "eb", "eg"]
    # types = ['ag', 'al', 'ap', 'au', 'a', 'bb', 'bc', 'bu', 'b', 'cf', 'cj', 'cs', 'cu', 'cy', 'c', 'eb', 'eg', 'fb', 'fg', 'fu', 'hc', 'i', 'jd', 'jm', 'jr', 'j', 'lh', 'lr', 'lu', 'l', 'm', 'ma',
    #          'ni', 'nr', 'oi', 'pb', 'pf', 'pg', 'pk', 'pm', 'pp', 'p', 'rb', 'ri', 'rm', 'rr', 'rs', 'ru', 'sa', 'sc', 'sf', 'sm', 'sn', 'sp', 'sr', 'ss', 'ta', 'ur', 'v', 'wh', 'wr', 'y', 'zc', 'zn']
    # statistic_peaks_v2(types)
    
    get_good_types()
    


