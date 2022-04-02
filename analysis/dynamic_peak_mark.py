import time
from helper import constance, date_utils, analysis_helper, domain_utils, file_utils, utils
from pymongo import MongoClient, DESCENDING, ASCENDING

def start_mark(last_peak, new_tick, records, price_diff, peak_price):
    if last_peak['status'] == "confirm":
        trigger_a_peak(new_tick, last_peak)
    elif last_peak['status'] == "":
        # Try to find the first peak
        initial_first_peak()
    elif last_peak['status'] == "verifing":
        # Do verify
        observe_peak(new_tick, last_peak)
        # Update position here
    elif last_peak['status'] == "preliminaryConfirm":
        # If pass, check whether mark wrong
        price_diff_confirm(new_tick, last_peak)
        # Update cut logic here

# 1. second mark must be in "confirm"
# 2. cjl must be increase fast
def trigger_a_peak():
    return

def initial_first_peak():
    return 

# 1. If cjl reduce fast, price reduce fast, then pass
# 2. If cjl increase and price still running, then still peaking, add more?
# 3. If no changes, more like a false peak.
def observe_peak():
    return

def price_diff_confirm(new_tick, last_peak):
    return
