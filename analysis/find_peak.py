import random
from collections import deque
from datetime import datetime, timedelta
import matplotlib.pyplot as plt
import mplcursors
import matplotlib.dates as mdates
import heapq


class DataProcessor:
    def __init__(self):
        self.data_queue = deque()
        self.extreme_points = []
        self.modified_extreme_points = []
        self.candidate_points = []
        self.discarded_candidates = []

    def process_new_data(self, data):
        while self.data_queue and data['time'] - self.data_queue[0]['time'] > timedelta(hours=4):
            popped_data = self.data_queue.popleft()

            # Check if any confirmed extreme point doesn't hold as an extreme point anymore
            for extreme in self.extreme_points:
                if not self.is_extreme_point(extreme):
                    self.extreme_points.remove(extreme)
                    self.modified_extreme_points.append(extreme)

            # Check if any candidate point can be confirmed as an extreme point
            for candidate in self.candidate_points:
                if self.is_extreme_point(candidate):
                    self.extreme_points.append(candidate)
                    self.candidate_points.remove(candidate)

        # Remove any candidate points that are older than 2 hours and record them
        self.candidate_points = [candidate for candidate in self.candidate_points
                                 if data['time'] - candidate['time'] <= timedelta(hours=2)]
        self.discarded_candidates.extend([candidate for candidate in self.candidate_points
                                          if data['time'] - candidate['time'] > timedelta(hours=2)])

        self.data_queue.append(data)

        if len(self.data_queue) >= 2 and data['time'] - self.data_queue[0]['time'] >= timedelta(hours=2):
            if self.is_candidate_point(data):
                self.candidate_points.append(data)

    def is_candidate_point(self, data):
        return data == max(self.data_queue, key=lambda x: x['price']) or \
            data == min(self.data_queue, key=lambda x: x['price'])

    def is_extreme_point(self, data):
        two_hours_ago = data['time'] - timedelta(hours=2)
        two_hours_later = data['time'] + timedelta(hours=2)

        earlier_data = [
            d for d in self.data_queue if two_hours_ago <= d['time'] <= data['time']]
        later_data = [d for d in self.data_queue if data['time']
                    <= d['time'] <= two_hours_later]

        if not earlier_data or not later_data:
            return False

        no_extreme_in_two_hours = all(
            [abs(data['time'] - point['time']) > timedelta(hours=2) for point in self.extreme_points])

        return no_extreme_in_two_hours and \
            (data['price'] == max(earlier_data, key=lambda x: x['price'])['price'] == min(later_data, key=lambda x: x['price'])['price'] or
            data['price'] == min(earlier_data, key=lambda x: x['price'])['price'] == max(later_data, key=lambda x: x['price'])['price'])



# 创建一个DataProcessor实例
dp = DataProcessor()


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
test_data = list(generate_test_data(datetime.now(), 6000))


# 处理测试数据
for data in test_data:
    dp.process_new_data(data)

# 提取时间和价格，绘制价格曲线
times = [mdates.date2num(data['time']) for data in test_data]
prices = [data['price'] for data in test_data]

plt.figure()
plt.plot_date(times, prices, fmt='-', label='Price')

# 提取极值点，绘制为蓝色点
extreme_times = [mdates.date2num(point['time']) for point in dp.extreme_points]
extreme_prices = [point['price'] for point in dp.extreme_points]
plt.scatter(extreme_times, extreme_prices,
            color='blue', label='Extreme Points')

# 提取候选点，绘制为绿色点
candidate_times = [mdates.date2num(point['time'])
                   for point in dp.candidate_points]
candidate_prices = [point['price'] for point in dp.candidate_points]
plt.scatter(candidate_times, candidate_prices,
            color='green', label='Candidate Points')

# 配置交互
crs = mplcursors.cursor(hover=True)


@crs.connect("add")
def on_add(sel):
    x, y = sel.target
    date = mdates.num2date(x).strftime('%Y-%m-%d %H:%M:%S')
    text = f"Time: {date}, Price: {y}"
    sel.annotation.set_text(text)


plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d %H:%M:%S'))
plt.gcf().autofmt_xdate()
plt.legend()
plt.show()
