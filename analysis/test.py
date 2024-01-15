import numpy as np

# 函数：计算Z-score
def calculate_z_score(data):
    mean = np.mean(data)
    std = np.std(data)
    return [(x - mean) / std for x in data]

# 假设的数据
ccls = [150000, 152000, 148000, 151000, 153000]  # 持仓量数据
zxjs = [4000, 4001, 3998, 4002, 4003]            # 价格数据

def calculate_diff_rate(data1, data2):
    data1_z = calculate_z_score(data1)
    data2_z = calculate_z_score(data2)
    data1_diff = np.diff(data1_z)
    data2_diff = np.diff(data2_z)
    return data1_diff / data2_diff

# 计算Z-score
ccls_z = calculate_z_score(ccls)
zxjs_z = calculate_z_score(zxjs)

print("持仓量Z-score:", ccls_z)
print("价格Z-score:", zxjs_z)
# 计算变化（差分）
ccls_diff = np.diff(ccls_z)
zxjs_diff = np.diff(zxjs_z)
print("持仓量变化:", ccls_diff)
print("价格变化:", zxjs_diff)

# 计算比率

ratios = zxjs_diff / ccls_diff

print("比率:", ratios)
