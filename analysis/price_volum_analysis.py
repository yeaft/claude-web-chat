from helper import constance, utils

def update_sum_ccl(contract_type):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    sec_col = constance.FUTURE_DB['tick_{}_sec'.format(contract_type)]
    count = 0
    for t in main_col.find():        
        if count > 0:
            sec_infos = list(sec_col.find({'time': {"$lte": t['time']} }).sort("time", -1).limit(1))
            if len(sec_infos) > 0 :
                sec_info = sec_infos[0]
                filter = {'time': t['time']}
                newvalues = {"$set": {'sum_ccl': t['ccl'] + sec_info['ccl']}}
                main_col.update_one(filter, newvalues)
        
        count +=1
    
        if count % 10000 == 1:
            utils.log("Finish {}".format(count))

def output_csv(contract_type):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    # c = 0
    with open("rb.csv", "w") as f:
        for t in main_col.find({"time":{"$gte":"2020-03-02 08:59:00.500", "$lte":"2022-01-01 00:00:00.000"}}):        
            f.write("{},{},{},{}\n".format(t['time'], t['zxj'], t['ccl'], t['sum_ccl']))
            # c+=1
            # if c >= 300000:
            #     return

def cjl_abnormal(contract_type, start_date, end_date):
    main_col = constance.FUTURE_DB['tick_{}_main'.format(contract_type)]
    max_ main_col.find({'time':{"$lte": end_date, "$gte": start_date}}).sort("time", 1):
        
        

if __name__ == "__main__":
    # update_sum_ccl("rb")
    output_csv("rb")
