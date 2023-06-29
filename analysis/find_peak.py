import random
from collections import deque
from datetime import datetime, timedelta
import matplotlib.pyplot as plt
import mplcursors
import matplotlib.dates as mdates
import heapq


class DataProcessor:
    def __init__(self, past_x_hour = 1, next_x_min=3, extreme_point_threshold=0.02):
        self.data = []
        self.candidate_points = []
        self.extreme_points = []
        self.error_points = []
        self.past_x_hours = past_x_hour
        self.past_x_hours_num = int(past_x_hour * 3600 / 5)
        self.next_x_min = next_x_min
        self.next_x_min_num = int(next_x_min * 60 / 5)
        self.extreme_point_threshold = extreme_point_threshold

    def process_new_data(self, data):
        self.data.append(data)
        n = len(self.data)
        if n < self.past_x_hours_num+self.next_x_min_num:  # We don't have enough data for a 2-hour window and additional 3 minutes
            return
        self.update_extreme_points(n)

    def update_extreme_points(self, n):
        check_point = self.data[n-self.next_x_min_num]
        last_2_hours_and_next_x_min_data = self.data[n-self.past_x_hours_num-self.next_x_min_num:n]
        
        if self.extreme_points:
            last_extreme_price = self.extreme_points[-1]['price']
            last_extreme_type = self.extreme_points[-1]['extreme_type']
            if (last_extreme_type == "max" and last_extreme_price - check_point['price'] / last_extreme_price < self.extreme_point_threshold) \
              or (last_extreme_type == "min" and check_point['price'] - last_extreme_price / last_extreme_price < self.extreme_point_threshold) :
                return  # The price difference is less than 2%, ignore this point
            
        max_price_point = max(
            last_2_hours_and_next_x_min_data, key=lambda x: x['price'])
        min_price_point = min(
            last_2_hours_and_next_x_min_data, key=lambda x: x['price'])

        if check_point['price'] == max_price_point['price']:
            check_point['extreme_type'] = 'max'
            self.candidate_points.append(check_point)
        elif check_point['price'] == min_price_point['price']:
            check_point['extreme_type'] = 'min'
            self.candidate_points.append(check_point)

        for candidate in self.candidate_points.copy():
            if candidate['time'] < self.data[-1]['time'] - timedelta(hours=2):
                self.candidate_points.remove(candidate)
                next_2_hours_data = self.data[n-self.past_x_hours_num:n]
                max_price_point = max(
                    next_2_hours_data, key=lambda x: x['price'])
                min_price_point = min(
                    next_2_hours_data, key=lambda x: x['price'])

                if (candidate['extreme_type'] == 'max' and candidate['price'] >= max_price_point['price']) or \
                   (candidate['extreme_type'] == 'min' and candidate['price'] <= min_price_point['price']):
                    self.extreme_points.append(candidate)
                else:
                    self.error_points.append(candidate)


# 创建一个DataProcessor实例
dps =[DataProcessor(1, 3),DataProcessor(1.5, 15), DataProcessor(2, 20), DataProcessor(2, 25), DataProcessor(3, 30)]

# 用于生成测试数据的函数
def generate_test_data(start_time, num_points, price_initial=2000):
    time = start_time
    price = price_initial
    for _ in range(num_points):
        ccl = random.uniform(0, 100)
        price += random.uniform(-2, 2)  # 限制价格变动范围在[-2, 2]之间
        yield {'time': time, 'ccl': ccl, 'price': price}
        time += timedelta(seconds=5)


# 测试数据：生成2小时的随机数据，每五秒一个数据点，总共1440个数据点
test_data = list(generate_test_data(datetime.now(), 20000))



# 处理测试数据
for data in test_data:
    for dp in dps:
        dp.process_new_data(data)

# 提取时间和价格
times = [mdates.date2num(data['time']) for data in test_data]
prices = [data['price'] for data in test_data]

fig, axs = plt.subplots(len(dps), 1, figsize=(10, 15))

for i, dp in enumerate(dps):
    axs[i].plot_date(times, prices, fmt='-', label='Price')
    extreme_times = [mdates.date2num(point['time']) for point in dp.extreme_points]
    extreme_prices = [point['price'] for point in dp.extreme_points]
    axs[i].scatter(extreme_times, extreme_prices, color='blue', label='Extreme Points')
    candidate_times = [mdates.date2num(point['time']) for point in dp.candidate_points]
    candidate_prices = [point['price'] for point in dp.candidate_points]
    axs[i].scatter(candidate_times, candidate_prices, color='green', label='Candidate Points')
    error_times = [mdates.date2num(point['time']) for point in dp.error_points]
    error_prices = [point['price'] for point in dp.error_points]
    axs[i].scatter(error_times, error_prices, color='red', label='Error Points')

    # 添加标题
    axs[i].set_title(f'{dp.past_x_hours} hours range - {dp.next_x_min} mins check - right rate: {round(len(dp.extreme_points) * 100 / (len(dp.extreme_points) + len(dp.error_points)), 2)}%, extreme num: {len(dp.extreme_points)}')


# # 配置交互
# crs = mplcursors.cursor(hover=True)


# @crs.connect("add")
# def on_add(sel):
#     x, y = sel.target
#     date = mdates.num2date(x).strftime('%Y-%m-%d %H:%M:%S')
#     text = f"Time: {date}, Price: {y}"
#     sel.annotation.set_text(text)
plt.subplots_adjust(hspace=0.5)
plt.show()
