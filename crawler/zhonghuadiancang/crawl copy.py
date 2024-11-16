import requests
from bs4 import BeautifulSoup
import os
import yaml
import time

# 定义全局变量
BASE_URL = 'https://www.zhonghuadiancang.com'
TAG_URL_TEMPLATE = 'https://www.zhonghuadiancang.com/tags-60-{}.html'
STATE_FILE = 'state.yaml'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
}

def save_state(state):
    with open(STATE_FILE, 'w', encoding='utf-8') as f:
        yaml.dump(state, f, allow_unicode=True)

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    else:
        return {'book_list': [], 'current_book_index': 0, 'current_chapter_url': ''}

def get_book_list():
    book_list = []
    for page_num in range(0, 55):  # 页码从0到54
        page_url = TAG_URL_TEMPLATE.format(page_num)
        response = requests.get(page_url, headers=HEADERS)
        response.encoding = 'utf-8'
        soup = BeautifulSoup(response.text, 'html.parser')
        tbody = soup.find('tbody')
        if tbody:
            rows = tbody.find_all('tr')
            for row in rows:
                cols = row.find_all('td')
                if len(cols) >= 2:
                    book_tag = cols[0].find('a')
                    author_tag = cols[1].find('a')
                    if book_tag and author_tag:
                        book_name = book_tag.text.strip()
                        book_url = book_tag['href']
                        author_name = author_tag.text.strip()
                        book_list.append({
                            'name': book_name,
                            'url': book_url,
                            'author': author_name
                        })
        print(f'已获取第 {page_num+1} 页的书籍列表，共 {len(book_list)} 本书')
        time.sleep(1)  # 避免请求过快
    return book_list

def get_book_info(book):
    response = requests.get(book['url'], headers=HEADERS)
    response.encoding = 'utf-8'
    soup = BeautifulSoup(response.text, 'html.parser')
    # 获取概要
    summary_tag = soup.find('p', class_='m-summary')
    summary = summary_tag.text.strip() if summary_tag else ''
    # 获取开始阅读的链接
    read_button = soup.find('a', text='开始阅读')
    if read_button:
        read_url = read_button['href'] # type: ignore
        if not read_url.startswith('http'): 
            read_url = BASE_URL + read_url
    else:
        read_url = ''
    # 获取章节列表（可选）
    chapter_list = []
    chapter_tags = soup.find_all('li', class_='list-group-item')
    for tag in chapter_tags:
        a_tag = tag.find('a')
        if a_tag:
            chapter_name = a_tag.text.strip()
            chapter_url = a_tag['href']
            if not chapter_url.startswith('http'):
                chapter_url = BASE_URL + chapter_url
            chapter_list.append({'name': chapter_name, 'url': chapter_url})
    return summary, read_url, chapter_list

def get_chapter_content(chapter_url):
    response = requests.get(chapter_url, headers=HEADERS)
    response.encoding = 'utf-8'
    soup = BeautifulSoup(response.text, 'html.parser')
    content_tag = soup.find('div', id='content', class_='panel-body')
    content = content_tag.get_text(separator='\n').strip() if content_tag else ''
    # 获取下一章的链接
    next_button = soup.find('a', text='下一章')
    if next_button:
        next_url = next_button['href']
        if not next_url.startswith('http'):
            next_url = BASE_URL + next_url
    else:
        next_url = ''
    return content, next_url

def save_book_content(book_name, author_name, summary, contents):
    filename = f'{book_name}-{author_name}.txt'
    with open(filename, 'w', encoding='utf-8') as f:
        f.write(f'书名：{book_name}\n')
        f.write(f'作者：{author_name}\n')
        f.write(f'概要：{summary}\n\n')
        for i, chapter in enumerate(contents):
            f.write(f'第 {i+1} 章：{chapter["title"]}\n')
            f.write(chapter['content'])
            f.write('\n\n' + '='*50 + '\n\n')
    print(f'已保存 {filename}')

def main():
    state = load_state()
    if not state.get('book_list'):
        print('正在获取书籍列表...')
        book_list = get_book_list()
        state['book_list'] = book_list
        save_state(state)
    else:
        book_list = state['book_list']
    total_books = len(book_list)
    for idx in range(state.get('current_book_index', 0), total_books):
        book = book_list[idx]
        book_name = book['name']
        author_name = book['author']
        print(f'正在爬取第 {idx+1}/{total_books} 本书：《{book_name}》 作者：{author_name}')
        summary, read_url, _ = get_book_info(book)
        if not read_url:
            print(f'未找到《{book_name}》的开始阅读链接，跳过此书')
            continue
        contents = []
        chapter_url = state.get('current_chapter_url') or read_url
        while True:
            content, next_url = get_chapter_content(chapter_url)
            chapter_title = chapter_url.split('/')[-1].replace('.html', '')
            contents.append({'title': chapter_title, 'content': content})
            print(f'已爬取章节：{chapter_title}')
            if next_url == chapter_url or not next_url:
                print('已到达最后一章')
                break
            chapter_url = next_url
            state['current_chapter_url'] = chapter_url
            save_state(state)
            time.sleep(1)  # 避免请求过快
        save_book_content(book_name, author_name, summary, contents)
        # 重置状态
        state['current_book_index'] = idx + 1
        state['current_chapter_url'] = ''
        save_state(state)
        time.sleep(2)  # 避免请求过快

if __name__ == '__main__':
    main()
