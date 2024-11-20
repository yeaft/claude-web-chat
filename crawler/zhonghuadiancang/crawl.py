import requests
from bs4 import BeautifulSoup
import os
import yaml
import time
import random
import re
import datetime

# 定义全局变量
BASE_URL = 'https://www.zhonghuadiancang.com'
STATE_FILE = 'state.yaml'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
}

# 定义要爬取的分类和标签
categories = [
    # {
    #     'name': '道教',
    #     'type': 'tag',
    #     'id': 60,
    # },
    {
        'name': '中医',
        'type': 'tag',
        'id': 80,
    },
    {
        'name': '修炼',
        'type': 'tag',
        'id': 81,
    },
    {
        'name': '佛学宝典',
        'type': 'category',
        'slug': 'foxuebaodian',
    },
    {
        'name': '国学知识',
        'type': 'category',
        'slug': 'guoxuezhishi',
    },
    # 可以根据需要添加更多分类或标签
]

def log(message):
    current_time = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    print(f'[{current_time}] {message}')

def save_state(state):
    with open(STATE_FILE, 'w', encoding='utf-8') as f:
        yaml.dump(state, f, allow_unicode=True)

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    else:
        return {'book_list': [], 'current_book_index': 0, 'current_chapter_url': ''}

def get_existing_items(category_name):
    existing_items = set()
    category_folder = category_name
    if not os.path.exists(category_folder):
        return existing_items
    for filename in os.listdir(category_folder):
        if filename.endswith('.txt'):
            # 移除文件扩展名
            name_author = filename[:-4]
            # 如果有标签部分，移除标签部分
            name_author = re.sub(r'-\([^)]*\)$', '', name_author)
            parts = name_author.split('-')
            if len(parts) >= 2:
                item_name = '-'.join(parts[:-1])
                author_name = parts[-1]
            else:
                item_name = parts[0]
                author_name = ''
            existing_items.add((item_name, author_name))
    return existing_items

def get_book_list(categories):
    book_list = []
    for category in categories:
        log(f"开始获取分类：{category['name']} 的列表")
        existing_items = get_existing_items(category['name'])
        items = get_book_list_for_category(category, existing_items)
        book_list.extend(items)
    return book_list

def get_book_list_for_category(category, existing_items):
    items = []
    page_num = 0
    while True:
        if category['type'] == 'tag':
            page_url = f"https://www.zhonghuadiancang.com/tags-{category['id']}-{page_num}.html"
        elif category['type'] == 'category':
            if page_num == 0:
                page_url = f"https://www.zhonghuadiancang.com/{category['slug']}/"
            else:
                page_url = f"https://www.zhonghuadiancang.com/{category['slug']}/index_{page_num+1}.html"
        else:
            log(f"未知的分类类型：{category['type']}")
            break

        try:
            response = requests.get(page_url, headers=HEADERS)
        except requests.exceptions.RequestException as e:
            log(f"请求页面 {page_url} 时发生异常：{e}")
            wait_time = random.uniform(300, 600)  # 等待5到10分钟
            log(f"等待 {int(wait_time)} 秒后重试")
            time.sleep(wait_time)
            continue  # 重新请求该页面

        if response.status_code == 404:
            log(f"页面 {page_url} 返回404，停止遍历该分类")
            break

        response.encoding = 'utf-8'
        soup = BeautifulSoup(response.text, 'html.parser')

        page_items, has_skip = parse_book_list_page(soup, existing_items, category['name'])
        if not page_items and not has_skip:
            log(f"未在页面 {page_url} 发现内容，停止遍历该分类")
            break

        items.extend(page_items)
        log(f"已获取分类 {category['name']} 第 {page_num+1} 页的列表，当前分类共 {len(items)} 项")
        page_num += 1
        time.sleep(random.uniform(0.5, 1.5))  # 避免请求过快

    return items

def parse_book_list_page(soup, existing_items, category_name):
    items = []
    has_skip = False
    tbody = soup.find('tbody')
    if tbody:
        rows = tbody.find_all('tr')
        for row in rows:
            cols = row.find_all('td')
            if len(cols) >= 2:
                item_tag = cols[0].find('a')
                author_tag = cols[1].find('a')
                if item_tag:
                    item_name = item_tag.text.strip()
                    item_url = item_tag['href']
                    if not item_url.startswith('http'):
                        item_url = BASE_URL + item_url
                    if author_tag:
                        author_name = author_tag.text.strip()
                    else:
                        author_name = '佚名'
                    if (item_name, author_name) in existing_items:
                        log(f"《{item_name}》作者：{author_name} 已存在，跳过")
                        has_skip = True
                        continue
                    items.append({
                        'name': item_name,
                        'url': item_url,
                        'author': author_name,
                        'category': category_name,
                    })
    else:
        # 尝试其他方式解析列表，适应不同的页面结构
        # 例如：查找 class 为 'bookbox' 的 div
        divs = soup.find_all('div', class_='bookbox')
        for div in divs:
            item_tag = div.find('h4').find('a')
            if item_tag:
                item_name = item_tag.text.strip()
                item_url = item_tag['href']
                if not item_url.startswith('http'):
                    item_url = BASE_URL + item_url
                # 尝试获取作者信息
                author_tag = div.find('p', class_='bookinfo').find('a')
                author_name = author_tag.text.strip() if author_tag else '佚名'
                if (item_name, author_name) in existing_items:
                    log(f"《{item_name}》作者：{author_name} 已存在，跳过")
                    continue
                items.append({
                    'name': item_name,
                    'url': item_url,
                    'author': author_name,
                    'category': category_name,
                })
    return items, has_skip

def get_item_info(item):
    while True:
        try:
            response = requests.get(item['url'], headers=HEADERS)
            break  # 请求成功，跳出循环
        except requests.exceptions.RequestException as e:
            log(f"请求 {item['url']} 时发生异常：{e}")
            wait_time = random.uniform(300, 600)  # 等待5到10分钟
            log(f"等待 {int(wait_time)} 秒后重试")
            time.sleep(wait_time)

    response.encoding = 'utf-8'
    soup = BeautifulSoup(response.text, 'html.parser')

    # 判断是否有 '开始阅读' 按钮，如果有，则认为是书籍，否则是文章
    read_button = soup.find('a', text='开始阅读')
    if read_button:
        item_type = 'book'
    else:
        item_type = 'article'

    if item_type == 'article':
        # 获取文章标题和作者
        title_tag = soup.find('div', class_='m-sptitle')
        if title_tag:
            h1_tag = title_tag.find('h1')
            if h1_tag:
                # 提取标题和作者
                small_tag = h1_tag.find('small')
                if small_tag:
                    author_text = small_tag.text.strip()
                    match = re.search(r'作者[:：](.*)', author_text)
                    if match:
                        author_name = match.group(1).strip()
                    else:
                        author_name = '佚名'
                    small_tag.extract()  # 移除作者部分
                else:
                    author_name = '佚名'
                article_title = h1_tag.text.strip()
            else:
                article_title = item['name']
                author_name = item['author'] or '佚名'
        else:
            article_title = item['name']
            author_name = item['author'] or '佚名'

        # 获取内容
        content_div = soup.find('div', class_='panel-body')
        content = content_div.get_text(separator='\n').strip() if content_div else ''
        # 获取标签（可选）
        tags = []
        return {
            'type': 'article',
            'title': article_title,
            'author': author_name,
            'content': content,
            'tags': tags,
        }
    else:
        # 处理书籍信息
        # 获取概要
        summary_tag = soup.find('p', class_='m-summary')
        summary = summary_tag.text.strip() if summary_tag else ''
        # 获取开始阅读的链接
        if read_button:
            read_url = read_button['href']
            if not read_url.startswith('http'):
                read_url = BASE_URL + read_url
        else:
            read_url = ''
        # 获取标签
        tags = []
        alert_div = soup.find('div', class_='alert')
        if alert_div:
            tag_links = alert_div.find_all('a')
            for tag_link in tag_links:
                tag_name = tag_link.text.strip()
                tags.append(tag_name)
        return {
            'type': 'book',
            'summary': summary,
            'read_url': read_url,
            'tags': tags,
        }

def get_chapter_content(chapter_url):
    while True:
        try:
            response = requests.get(chapter_url, headers=HEADERS)
            break  # 请求成功，跳出循环
        except requests.exceptions.RequestException as e:
            log(f"请求 {chapter_url} 时发生异常：{e}")
            wait_time = random.uniform(300, 600)  # 等待5到10分钟
            log(f"等待 {int(wait_time)} 秒后重试")
            time.sleep(wait_time)

    response.encoding = 'utf-8'
    soup = BeautifulSoup(response.text, 'html.parser')
    content_tag = soup.find('div', id='content', class_='panel-body')
    content = content_tag.get_text(separator='\n').strip() if content_tag else ''
    # 获取章节标题
    title_tag = soup.find('div', class_='panel-footer')
    if title_tag:
        h1_tag = title_tag.find('h1')
        chapter_title = h1_tag.text.strip() if h1_tag else ''
    else:
        chapter_title = ''
    # 获取下一章的链接
    next_button = soup.find('a', text='下一章')
    if next_button:
        next_url = next_button['href']
        if not next_url.startswith('http'):
            next_url = BASE_URL + next_url
    else:
        next_url = ''
    return chapter_title, content, next_url

def sanitize_filename(filename):
    # 去除或替换文件名中不合法的字符
    invalid_chars = r'\/:*?"<>|'
    for c in invalid_chars:
        filename = filename.replace(c, '_')
    # 去除首尾空格
    filename = filename.strip()
    return filename

def save_article_content(article_title, author_name, content, tags, category_name):
    # 创建文件夹
    folder_path = category_name
    if not os.path.exists(folder_path):
        os.makedirs(folder_path)
    # 创建文件名
    filename = f'{article_title}-{author_name}.txt'
    filename = sanitize_filename(filename)
    file_path = os.path.join(folder_path, filename)
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(f'标题：{article_title}\n')
        f.write(f'作者：{author_name}\n')
        f.write('\n')
        f.write(content)
    log(f'已保存 {file_path}')

def save_book_content(book_name, author_name, summary, contents, tags, category_name):
    # 创建文件夹
    folder_path = category_name
    if not os.path.exists(folder_path):
        os.makedirs(folder_path)
    # 创建文件名
    tag_part = ','.join(tags)
    filename = f'{book_name}-{author_name}-({tag_part}).txt'
    filename = sanitize_filename(filename)
    file_path = os.path.join(folder_path, filename)
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(f'书名：{book_name}\n')
        f.write(f'作者：{author_name}\n')
        f.write(f'标签：{tag_part}\n')
        f.write(f'概要：{summary}\n\n')
        for i, chapter in enumerate(contents):
            if chapter['content'].strip() == '':
                continue  # 跳过内容为空的章节
            f.write(f'第 {i+1} 章 {chapter["title"]}\n')
            f.write(chapter['content'])
            f.write('\n\n' + '='*50 + '\n\n')
    log(f'已保存 {file_path}')

def main():
    state = load_state()
    if not state.get('book_list'):
        log('正在获取内容列表...')
        book_list = get_book_list(categories)
        state['book_list'] = book_list
        state['current_book_index'] = 0
        save_state(state)
    else:
        book_list = state['book_list']
    total_items = len(book_list)
    for idx in range(state.get('current_book_index', 0), total_items):
        item = book_list[idx]
        name = item['name']
        author_name = item['author']
        category_name = item['category']
        existing_items = get_existing_items(category_name)
        if (name, author_name) in existing_items:
            log(f"《{name}》作者：{author_name} 已存在，跳过")
            continue
        log(f'正在爬取第 {idx+1}/{total_items} 个项目：《{name}》')

        item_info = get_item_info(item)
        item_type = item_info['type']

        if item_type == 'article':
            article_title = item_info['title']
            author_name = item_info['author']
            content = item_info['content']
            tags = item_info['tags']
            if not content:
                log(f'文章《{article_title}》内容为空，跳过')
                continue
            save_article_content(article_title, author_name, content, tags, category_name)
            existing_items.add((article_title, author_name))
        else:
            # 处理书籍
            summary = item_info['summary']
            read_url = item_info['read_url']
            tags = item_info['tags']
            if not read_url:
                log(f'未找到《{name}》的开始阅读链接，跳过此书')
                continue
            contents = []
            chapter_url = state.get('current_chapter_url') or read_url
            visited_urls = set()  # 防止循环
            while True:
                if chapter_url in visited_urls:
                    log('检测到章节循环，停止爬取本书')
                    break
                visited_urls.add(chapter_url)
                chapter_title, content, next_url = get_chapter_content(chapter_url)
                if content.strip() == '':
                    log(f'章节《{chapter_title}》内容为空，跳过')
                    break  # 跳出循环，不再继续
                contents.append({'title': chapter_title, 'content': content})
                log(f'已爬取章节：{chapter_title}')
                if next_url == chapter_url or not next_url:
                    log('已到达最后一章')
                    break
                chapter_url = next_url
                state['current_chapter_url'] = chapter_url
                save_state(state)
                time.sleep(random.uniform(0.5, 1.5))  # 避免请求过快
            if contents:
                save_book_content(name, author_name, summary, contents, tags, category_name)
                existing_items.add((name, author_name))
            else:
                log(f'《{name}》没有有效内容，跳过保存')

        # 重置状态
        state['current_book_index'] = idx + 1
        state['current_chapter_url'] = ''
        save_state(state)
        time.sleep(random.uniform(0.5, 1.5))  # 避免请求过快

if __name__ == '__main__':
    main()
