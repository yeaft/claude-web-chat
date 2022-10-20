import time
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from pymongo import MongoClient, DESCENDING, ASCENDING

def mark_peaks(code, min_diff_rate):
    start_time = time.time()
    ticks = domain_utils.collect_ticks_by_code(constance.REAL_TIME_TICK_COL, constance.REAL_TIME_TICK_SECOND_COL, code)
    if len(ticks) < 100:
        return
    else:
        utils.log("Code {0} has {1} ticks".format(code, len(ticks)))

    peak_infos, i = [], 10
    log_open = False
    while i < len(ticks):
        if log_open:
            return
        # if ticks[i]['time'] == "20220329 141700":
        #     log_open = True
        #     utils.log("in")
        current_price = ticks[i]['zxj']
        price_diff = int(ticks[i]['zxj'] * min_diff_rate)
        # See past ticks
        crest_ok, trough_ok, past_i = True, True, i-1
        while (crest_ok or trough_ok) and past_i >= 0:
            # check crest
            past_price = ticks[past_i]['zxj']
            if past_price < current_price:
                trough_ok = False
                if past_price <= current_price - price_diff:
                    break
            
            if past_price > current_price:
                crest_ok = False
                if past_price >= current_price + price_diff:
                    break
            
            past_i -= 1
        
        # if log_open:
        #     utils.log("{0}, {1}, past price {2}, {3}, {4}, {5}".format(i, past_i, ticks[past_i]['time'], ticks[past_i]['zxj'], price_diff, current_price + price_diff))
        #     if not trough_ok:
        #         utils.log("error!")
        #         return
        if past_i <= 0:            
            i+= 1
            continue

        # See future
        next_i = i+1
        while (crest_ok or trough_ok) and next_i < len(ticks):
            next_price = ticks[next_i]['zxj']
            if crest_ok:
                if next_price > current_price:
                    break
                if next_price <= current_price - price_diff:
                    utils.log("crest  [{0}] {1} {2},{3},{4}".format(ticks[i]['time'], ticks[next_i]['time'], current_price, ticks[next_i]['zxj'], price_diff))
                    # Record peak
                    peak_info = {
                        "code": code,
                        "type": domain_utils.convert_code_to_contract_type(code),
                        "diffRate": min_diff_rate,
                        "time": ticks[i]['time'],
                        "peakType": "crest",
                        "zxj": ticks[i]['zxj']
                    }
                    peak_infos.append(peak_info)
                    i = next_i - 1
                    break
            
            elif trough_ok:
                if log_open:
                    utils.log("{2}, {0}, {1}".format(ticks[next_i]['zxj'], current_price+price_diff, ticks[next_i]['time']))
                if next_price < current_price:
                    if log_open:
                        utils.log("error next, {0}, {1}".format(ticks[next_i]['time'], next_i))
                        return
                    break
                if next_price >= current_price + price_diff:
                    utils.log("trough [{0}] {1} {2},{3},{4}".format(ticks[i]['time'], ticks[next_i]['time'], current_price, ticks[next_i]['zxj'], price_diff))
                    # Record peak
                    peak_info = {
                        "code": code,
                        "type": domain_utils.convert_code_to_contract_type(code),
                        "diffRate": min_diff_rate,
                        "time": ticks[i]['time'],
                        "peakType": "trough",
                        "zxj": ticks[i]['zxj']
                    }
                    peak_infos.append(peak_info)
                    i = next_i - 1
                    break
            
            next_i += 1
        i+=1
    
    utils.log("Code {0} ticks number {1}, has {2} peaks in diff rate {3}".format(code, len(ticks), len(peak_infos), min_diff_rate))
    if len(peak_infos) > 0:
        constance.HISTORY_PEAK_COL.insert_many(peak_infos)
    
    utils.log("Finish get peaks using {}s".format(round(time.time() - start_time, 2)))


if __name__ == "__main__":
    mark_peaks("sa209", 0.005)