import math

from constance import *
from statistics import mean, variance, stdev


def predict_base(res, up_type, down_type, datas, data, position, factor, print_data=False):
    past_day_span = factor['pastDay']
    win_jsp_per = factor['winJspPer']
    win_diff_per = factor['winDiffPer']
    cut_peak_day = factor['cutPeakDay']
    cut_peak_per = factor['cutPeakPer']

    predict = {}
    if up_type in res:
        predict['direction'] = "up"
        predict['price'] = max((1 + win_jsp_per) * data['jsp'],  win_diff_per * (get_past_n_day_max(datas, position, past_day_span) - data['jsp']) + data['jsp'])
        predict['per'] = predict['price'] / data['jsp']
        predict['cutPrice'] = get_past_n_day_min(datas, position, cut_peak_day) * (1 - cut_peak_per)
        predict['cutPer'] = predict['cutPrice'] / data['jsp']
    elif down_type in res:
        predict['direction'] = "down"
        predict['price'] = min((1 - win_jsp_per) * data['jsp'], data['jsp'] - win_diff_per * (data['jsp'] - get_past_n_day_min(datas, position, past_day_span)))
        predict['per'] = 2 - predict['price'] / data['jsp']
        predict['cutPrice'] = get_past_n_day_max(datas, position, cut_peak_day) * (1 + cut_peak_per)
        predict['cutPer'] = 2 - predict['cutPrice'] / data['jsp']
    if print_data:
        echo_dic(predict)

    return predict

def convert_predict_price_to_current(data, predict):
    converted_predict = {}
    current_data = get_current_price(data)
    converted_predict['code'] = current_data['code']
    converted_predict['date'] = current_data['date']
    converted_predict['jsp'] = current_data['jsp']
    converted_predict['price'] = int(current_data['jsp'] * (predict['per'] if predict['direction'] == "up" else 2 - predict['per']))
    converted_predict['cutPrice'] = int(current_data['jsp'] * (predict['cutPer'] if predict['direction'] == "up" else 2 - predict['cutPer']))
    converted_predict['pricePer'] = round(predict['per'], 2)
    converted_predict['cutPer'] = round(predict['cutPer'], 2)
    return converted_predict


def get_current_price(data):
    return INFO_COL.find_one({'code': data['code'], 'date': data['date']})

def verify_trade(datas, data, position, next_range, predict, predict_price, cut_price, need_max = False):
    future_datas = datas[position + 1:position + next_range + 1]
    return verify_trade_inner(future_datas, data, next_range, predict, predict_price, cut_price, need_max)
    

def verify_trade_inner(future_datas, data, next_range, predict, predict_price, cut_price, need_max):
    trade_type = ""
    trade_day = 0
    for f in future_datas:
        trade_day += 1
        if predict == "up":
            if f['zgj'] >= predict_price and f['zdj'] <= cut_price:
                trade_type = "conf"
                trade_result = 1
                break
            elif f['zgj'] >= predict_price:
                trade_type = "win"
                trade_result = predict_price / data['jsp']
                break
            elif f['zdj'] <= cut_price:
                trade_type = "cut"
                trade_result = cut_price / data['jsp']
                break
        else:
            if f['zdj'] <= predict_price and f['zgj'] >= cut_price:
                trade_type = "conf"
                trade_result = 1
                break
            if f['zdj'] <= predict_price:
                trade_type = "win"
                trade_result = 2 - predict_price / data['jsp']
                break
            elif f['zgj'] >= cut_price:
                trade_type = "cut"
                trade_result = 2 - cut_price / data['jsp']
                break

    if trade_type == "":
        trade_type = "no"
        if predict == "up":
            trade_result = future_datas[-1]['jsp'] / data['jsp']
        elif predict == "down":
            trade_result = 2 - future_datas[-1]['jsp'] / data['jsp']
        else:
            trade_result = 1

    verify_res = VERIFY_COL.find_one({"type": data['type'], "date": data['date'], "range": next_range}) if need_max else None
    min_per = verify_res['minPer'] if verify_res != None else 0
    max_per = verify_res['maxPer'] if verify_res != None else 0

    return {'tradeType': trade_type, 'tradePer': trade_result, 'tradeDay': future_datas[trade_day-1]['date'], 'minPer': min_per, 'maxPer': max_per}

def statistic_candle(results, with_all = True, echo = True):
    # Final statistic
    # candleType, type,  allCount  match  rate   finalResult
    statistic = {}
    for res in results:
        if res['candleType'] not in statistic:
            statistic[res['candleType']] = {}

        if with_all:
            if 'all' not in statistic[res['candleType']]:
                statistic[res['candleType']]['all'] = {}
                statistic[res['candleType']]['all']['candleType'] = res['candleType']
                statistic[res['candleType']]['all']['type'] = 'all'
                statistic[res['candleType']]['all']['count'] = 0
                statistic[res['candleType']]['all']['match'] = 0
                statistic[res['candleType']]['all']['rate'] = 0
                statistic[res['candleType']]['all']['tradeRes'] = 1

            statistic[res['candleType']]['all']['count'] += 1
            statistic[res['candleType']]['all']['match'] += (1 if res['tradeType'] == "win" else 0)
            statistic[res['candleType']]['all']['tradeRes'] *= res['tradePer']

        if res['type'] not in statistic[res['candleType']]:
            statistic[res['candleType']][res['type']] = {}
            statistic[res['candleType']][res['type']]['candleType'] = res['candleType']
            statistic[res['candleType']][res['type']]['type'] = res['type']
            statistic[res['candleType']][res['type']]['count'] = 0
            statistic[res['candleType']][res['type']]['match'] = 0
            statistic[res['candleType']][res['type']]['rate'] = 0
            statistic[res['candleType']][res['type']]['tradeRes'] = 1
            if 'factor' in res:
                statistic[res['candleType']][res['type']]['factor'] = res['factor']

        statistic[res['candleType']][res['type']]['count'] += 1
        statistic[res['candleType']][res['type']]['match'] += (1 if res['tradeType'] == "win" else 0)
        statistic[res['candleType']][res['type']]['tradeRes'] *= res['tradePer']

    statistic_arr = []

    for k, v in statistic.items():
        for t, val in v.items():
            val['rate'] = round(val['match'] * 100.00 / val['count'], 2)
            # if val['rate'] < 30:
            #     continue
            val['tradeRes'] = round(val['tradeRes'], 4) if val['type'] != 'all' else - 1 * round(val['tradeRes'], 4)
            val['tradePowAvgRes'] = pow_base(val['count'], val['tradeRes'], base=0.9)
            statistic_arr.append(val)

    statistic_arr.sort(key=lambda x: x['tradeRes'], reverse=True)
    if echo and len(statistic_arr) > 0:
        echo_dics(statistic_arr)

    return statistic_arr

def generate_result(contractType, date, candleType, candleSubType, tradeType, predict, predictPer, cutPer, tradeResult, minPer, maxPer):
    result = {}
    result['type'] = contractType
    result['date'] = date
    result['candleType'] = candleType
    result['candleSubType'] = candleSubType
    result['tradeType'] = tradeType
    result['predict'] = predict
    result['predictPer'] = predictPer
    result['cutPer'] = cutPer
    result['tradePer'] = tradeResult
    result['minPer'] = minPer
    result['maxPer'] = maxPer
    return result
    
def get_position_from_data(datas, date):
    position = -1
    for i in range(0, len(datas)):
        if datas[i]['date'] == date:
            position = i
            break
    return position


def get_past_n_day_min(data, i, n, price_type = "zdj"):
    if i - n >= 0:
        return min(list(d[price_type] for d in data[i - n:i + 1] if d[price_type] != 0))
    else:
        LOGGER.info("{} {} {}".format(n, i, data))


def get_past_n_day_max(data, i, n, price_type="zgj"):
    if i - n >= 0:
        return max(list(d[price_type] for d in data[i - n:i + 1]))
    else:
        LOGGER.info("{} {} {}".format(n, i, data))

def convert_array_to_obj(keys, vals):
    obj = {}
    if len(keys) == len(vals):
        for i in range(0, len(keys)):
            obj[keys[i]] = convert_val(vals[i])

    return obj

def convert_val(val):
    value = ""
    try:
        value=int(val)
    except ValueError:
        try:
            value=round(float(val), 4)
        except ValueError:
            value = val

    return value

def pow_base(pow_val, target, base=1,  final_accuracy=0.0001, accuracy=0.01):
    while True:
        try:
            temp_val = math.pow(base, pow_val)
            if temp_val == target:
                return base
            if temp_val > target:
                base -= accuracy
                if accuracy > final_accuracy:                
                    accuracy /= 10
                else:
                    return base

            base += accuracy
        except Exception as e:
            return base


def pow_times(base, target):
    times = 0
    while True:
        temp_val = math.pow(base, times)
        if temp_val >= target:
            return times
        times += 1

def get_header_by_candle_type(candle_type):
    if candle_type == "chz":
        head = "candleType,type,count,match,rate,tradeRes,pastDay,middleRate,topRate,trendPer,nearPeakPer,inPeakTrend,winJspPer,winDiffPer,cutPeakDay,cutPeakPer,tradePowAvgRes,tradeAvgRes,tradeStdev"
    elif candle_type == "abs":
        head = "candleType,type,count,match,rate,tradeRes,pastDay,bodyRate,trendPer,peakDay,winJspPer,winDiffPer,cutPeakDay,cutPeakPer,tradePowAvgRes,tradeAvgRes,tradeStdev"

    return head.split(",")


def get_factor_keys_by_candle_type(candle_type):
    head = ""
    if candle_type == "chz":
        head = "pastDay,middleRate,topRate,trendPer,nearPeakPer,inPeakTrend,winJspPer,winDiffPer,cutPeakDay,cutPeakPer"
    elif candle_type == "abs":
        head = "pastDay,bodyRate,trendPer,peakDay,winJspPer,winDiffPer,cutPeakDay,cutPeakPer"

    return head.split(",")

# 0. factor infor consists of three parts, 1.info. 2. select factor 3. trade factor
# 1. according to opt type, convert all contract type and count pair to select factor list
# 2. according to select factor, choose win selection. definition is 1. len(trade res > 1.0) >> len(trade res < 1.0) 2. len(trade res > 1.3)?
# 3. according to win selection, to get top n trade factor
# 4. combine select factor and trade factor
# candleType	type	count	match	rate	tradeRes	pastDay	middleRate	topRate	trendPer	nearPeakPer	inPeakTrend	winJspPer	winDiffPer	cutPeakDay	cutPeakPer
# chz	ru	184	64	34.78	2.6377	4	0.5	0.4	0.035	0.03	0.15	0.05	0.8	1	0.01

def expect_optmise_filter(candle_type, factor_strs, select_trade_factor_count = 3, select_factors_count=20, trade_res_threshold=1.1, avg_res_threshold = 1.005, avg_base_res_threshold = 1.005, variance_threshold = 0.5, output_path = "."):
    final_factors = []
    record = {}
    head = get_header_by_candle_type(candle_type)
    load_count = 0
    for factor_str in factor_strs:
        load_count += 1
        factor = factor_str.replace("\n", "").split(",")
        factor_id = get_factor_str_id(factor)
        if len(record) < select_factors_count and factor_id not in record:
            record[factor_id] = initialize_factor_optmise_record(factor_id)
            
        if factor_id in record:
            select_part = get_factor_str_select_part(factor_str)
            record[factor_id]['selectFactors'].add(select_part)
            record[factor_id]['factors'].append(convert_array_to_obj(head, factor))

    optmise_types = ['expect', 'winRate']    
    opt_results = {}
    for t in optmise_types:
        opt_results[t] = []

    for factor_id, factor_record in record.items():
        factors = factor_record['factors']
        trade_res_list = list((x['tradeRes'] for x in factors))
        
        # ignore factors not meet thresholds
        # 85%的情况下是盈利的，说明这个selection是不错的
        avg_res = round(mean(trade_res_list), 4)
        res_gt_one = sum(1 for x in trade_res_list if x > 1)
        v_res = round(variance(trade_res_list), 4)
        stdev_res = round(stdev(trade_res_list), 8)
        if avg_res - stdev_res < 1:
            LOGGER.info("{} not a good selection".format(factor_id))
        # if res_gt_one * 100 / len(trade_res_list) < 60 and avg_res < avg_res_threshold:
        #     record[factor_id] = {}
            continue
        
        # weighted average each trade factor
        sum_res = sum(trade_res_list)
        weighted_avg_wjp = round(sum(list(x['winJspPer'] * x['tradeRes'] for x in factors)) / sum_res, 4)
        weighted_avg_wdp = round(sum(list(x['winDiffPer'] * x['tradeRes'] for x in factors)) / sum_res, 4)
        weighted_avg_cpd = round(sum(list(x['cutPeakDay'] * x['tradeRes'] for x in factors)) / sum_res, 4)
        weighted_avg_cpp = round(sum(list(x['cutPeakPer'] * x['tradeRes'] for x in factors)) / sum_res, 4)
        max_wjp = max(list(x['winJspPer'] for x in factors))
        min_wjp = min(list(x['winJspPer'] for x in factors))
        max_cpp = max(list(x['cutPeakPer'] for x in factors))
        min_cpp = min(list(x['cutPeakPer'] for x in factors))
        middle_wjp = round((max_wjp + min_wjp) / 2, 4)
        middle_cpp = round((max_cpp + min_cpp) / 2, 4)

        # choose one selection and three trade factor
        # TODO according to factor's stdev
        cut_factor_keys = head[-4:]
        for i in range(0, len(cut_factor_keys)):
            factors.sort(key=lambda x: x[cut_factor_keys[i]], reverse=i == 2)
        
        for optmise_type in optmise_types:
            if optmise_type == "expect":
                factors.sort(key=lambda x: x['rate'], reverse=True)
                factors.sort(key=lambda x: x['tradeRes'], reverse=True)
            elif optmise_type == "winRate":
                factors.sort(key=lambda x: x['tradeRes'], reverse=True)
                factors.sort(key=lambda x: x['rate'], reverse=True)
            else:
                break
                
            selected_trade_count = 0
            selected_trade_res = 0
            for factor in factors:
                if factor['tradeRes'] != selected_trade_res:
                    opt_result = {}
                    opt_result['type'] = factor['type']
                    opt_result['candleType'] = factor['candleType']
                    opt_result['count'] = factor['count']
                    opt_result['rate'] = factor['rate']
                    opt_result['tradeRes'] = factor['tradeRes']
                    opt_result['tradePowAvgRes'] = factor['tradePowAvgRes']
                    opt_result['tradeAvgRes'] = factor['tradeAvgRes']
                    opt_result['tradeStdev'] = factor['tradeStdev']
                    opt_result['selectionAvgRes'] = avg_res
                    opt_result['selectionStdevRes'] = stdev_res
                    # if opt_result['tradePowAvgRes'] < avg_base_res_threshold or (factor['tradeAvgRes'] - 0.5 * factor['tradeStdev']) < 1:
                    # 0.3 = 60%
                    if (factor['tradeAvgRes'] - 0.3 * factor['tradeStdev']) < 1:
                        continue

                    factor_keys = get_factor_keys_by_candle_type(opt_result['candleType'])
                    for k in factor_keys:
                        opt_result[k] = factor[k]

                    opt_result['wAvgWjp'] = weighted_avg_wjp
                    opt_result['wAvgWdp'] = weighted_avg_wdp
                    opt_result['wAvgCpd'] = weighted_avg_cpd
                    opt_result['wAvgCpp'] = weighted_avg_cpp
                    opt_result['midWjp'] = middle_wjp
                    opt_result['midCpp'] = middle_cpp
                    
                    opt_results[optmise_type].append(opt_result)
                    selected_trade_count += 1
                    selected_trade_res = factor['tradeRes']
                
                if selected_trade_count >= select_trade_factor_count:
                    break

    for optmise_type in optmise_types:
        opt_res = opt_results[optmise_type]
        if len(opt_res) > 0:
            contract_type = opt_res[0]['type']
            opt_res.sort(key=lambda x: x['selectionAvgRes'], reverse=True)
            convert_dic_to_csv("{}/{}_{}_{}_best_factors_stdev".format(output_path, optmise_type, contract_type, candle_type), opt_res)
        else:
            LOGGER.info("There is no optmised data")
        

def initialize_factor_optmise_record(factor_id):
    temp = {}
    temp['factorId'] = factor_id
    temp["winC"] = 0
    temp["lossC"] = 0
    temp["resSum"] = 0
    temp["selectFactors"] = set()
    temp["factors"] = []
    temp['tradeFactors'] = []
    return temp

def get_factor_str_id(factors):
    return ",".join(factors[0:3])

def get_factor_str_select_part(factors):
    return ",".join(factors[6:-7])

def get_factor_str_trade_part(factors):
    return ",".join(factors[-7:-3])

def get_factor_dic(factor):
    factor_dic = {}
    if "candleType" in factor:
        candle_type = factor['candleType']
        keys = get_factor_keys_by_candle_type(candle_type)
        for key in keys:
            factor_dic[key] = factor[key]

    return factor_dic

def analysis_max_min_for_select_datas(datas, next_range):
    maxs = []
    mins = []
    select_datas = []
    for data in datas:
        verify = VERIFY_COL.find_one({"type": data['type'], "date": data['date'], "range": next_range})
        if verify == None:
            LOGGER.info("None verify data: {}, {}, {}".format(data['type'], data['date'], next_range))
            continue

        maxs.append(verify['maxPer'])
        mins.append(verify['minPer'])
        select_datas.append("{}-{}".format(data['type'], data['date']))
    
    max_avg = round(mean(maxs), 4)
    max_stdev = round(stdev(maxs), 8)
    min_avg = round(mean(mins), 4)
    min_stdev = round(stdev(mins), 8)

    return {
        "maxAvg": round(mean(maxs), 4),
        "maxStdev": round(stdev(maxs), 8),
        "up16": max_avg + max_stdev,
        "up31": max_avg + 0.5 * max_stdev,
        "up69": max_avg - 0.5 * max_stdev,
        "up84": max_avg - max_stdev,
        "minAvg": round(mean(mins), 4),
        "minStdev": round(stdev(mins), 8),
        "down16": min_avg - min_stdev,
        "down31": min_avg - 0.5 * min_stdev,
        "down69": min_avg + 0.5 * min_stdev,
        "down84": min_avg + min_stdev,
        "tradeU84D16": (max_avg - max_stdev) * 0.84 + (min_avg - min_stdev) * 0.16,
        "tradeU84D31": ((max_avg - max_stdev) * 0.84 + (min_avg - 0.5 * min_stdev) * 0.31) / 1.15,
        "tradeU69D16": ((max_avg - 0.5 * max_stdev) * 0.69 + (min_avg - min_stdev) * 0.16) / 0.85,
        "tradeU69D31": (max_avg - 0.5 * max_stdev) * 0.69 + (min_avg - 0.5 * min_stdev) * 0.31,
        "tradeU16D84": (max_avg + max_stdev) * 0.16 + (min_avg + min_stdev) * 0.84,
        "tradeU31D84": ((max_avg + 0.5 * max_stdev) * 0.31 + (min_avg + min_stdev) * 0.84) / 1.15,
        "tradeU16D69": ((max_avg + max_stdev) * 0.16 + (min_avg + 0.5 * min_stdev) * 0.69) / 0.85,
        "tradeU31D69": (max_avg + 0.5 * max_stdev) * 0.31 + (min_avg + 0.5 * min_stdev) * 0.69,
        "tradeU50D50": max_avg * 0.5 + min_avg * 0.5,
        "selectData" : "|".join(select_datas)
    } if len(maxs) > 1 and len(mins) > 1 else{}
    

def available_types():
    max_date = MAIN_COL.find_one({"type": "ru"}, sort=[('date', DESCENDING)])['date']
    available_contracts = list(MAIN_COL.find({"date": max_date, "cjl": {"$gt": 50000}}))
    types = list(x['type'] for x in available_contracts)
    types.sort()
    return types


def available_codes():
    max_date = MAIN_COL.find_one({"type": "ru"}, sort=[('date', DESCENDING)])['date']
    available_contracts = list(MAIN_COL.find({"date": max_date, "cjl": {"$gt": 50000}}))
    types = list(x['code'] for x in available_contracts)
    types.sort()
    return types

if __name__ == "__main__":
    # LOGGER.info(convert_val("0.5"))
    # LOGGER.info(convert_val("5"))
    # LOGGER.info(convert_val("a"))
    # click.echo(pow_times(1.045, 300))
    click.echo(pow_base(9, 3.44))
