from helper import constance, utils

def update_sum_ccl(contract_type):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    sec_col = constance.FUTURE_DB['tick_{}_sec'.format(contract_type)]
    count = 0
    for t in sec_col.find():
        count += 1
        main_info = main_col.find_one({'time': t['time']})
        if main_info != None:
            filter = {'time': t['time']}
            newvalues = {"$set": {'sum_ccl': t['ccl'] + main_info['ccl']}}
            main_col.update_one(filter, newvalues)
        
        if count % 10000 == 1:
            utils.log("Finish {}".format(count))



if __name__ == "__main__":
    update_sum_ccl("rb")
