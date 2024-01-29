import pandas as pd

# 初始化空的DataFrame
df = pd.DataFrame()

# 假设这是一个新的数据点，可能包含多个字段
new_data = {'time': '2024-01-01 00:00:05', 'zxj': 100, 'ccl': 200, 'other_field': 'value'}

# 使用object.keys动态添加新数据的字段
for key in new_data.keys():
    if key not in df:
        df[key] = pd.Series()
    df.at[len(df), key] = new_data[key]

# 将时间转换为datetime，并设置为索引
df['time'] = pd.to_datetime(df['time'])
df.set_index('time', inplace=True)

# 定义窗口大小
window_size = 3 * 60 * 60 / 5  # 3小时内的数据点数量

# 计算变化率
df['zxj_change'] = df['zxj'].pct_change()
df['ccl_change'] = df['ccl'].pct_change()

# 使用滚动窗口计算Z-score
df['zxj_zscore'] = df['zxj_change'].rolling(window=int(window_size), min_periods=1).apply(
    lambda x: (x[-1] - x.mean()) / x.std() if x.std() > 0 else 0
)
df['ccl_zscore'] = df['ccl_change'].rolling(window=int(window_size), min_periods=1).apply(
    lambda x: (x[-1] - x.mean()) / x.std() if x.std() > 0 else 0
)

# 选择一个阈值来识别异常值
zscore_threshold = 2

# 识别异常值
df['zxj_anomaly'] = df['zxj_zscore'].abs() > zscore_threshold
df['ccl_anomaly'] = df['ccl_zscore'].abs() > zscore_threshold

# 打印最新的数据点和其Z-score
print(df.tail(1))
