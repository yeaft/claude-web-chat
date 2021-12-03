import constance
import utils
from statistics import mean, variance, stdev
from pymongo import MongoClient, DESCENDING, ASCENDING

def convert_contract_code_to_name(code):
    return constance.CONTRACT_CODE_MAP[code]


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
    return (100 / constance.TIMES_MAP[contract_type]) if contract_type in constance.TIMES_MAP else 8


def active_contracts():
    contracts = list(x['type'] for x in list(
        constance.MAIN_COL.find({"date": "20201210", "cjl": {"$gt": 50000}})))
    contracts.sort()
    return contracts


def convert_code_to_standard_code(info):
    date = info['date']
    contract_type = info['type'].replace("\t", "").replace(" ", "")
    code = info['code'].replace("\t", "").replace(" ", "")
    number_str = ""
    for c in code:
        if utils.is_number(c):
            number_str += c
    suffix_num = number_str[-3:]
    if date[3:4] != suffix_num[0:1] and date[3:4] == "9":
        ten_year = str(int(date[2:3]) + 1)
    else:
        ten_year = date[2:3]
    real_code = contract_type.lower() + ten_year + number_str[-3:]
    return real_code
