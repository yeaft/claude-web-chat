import os
import re
import sys
import time
import yaml
import glob
import argparse
import datetime
from openai import OpenAI  # 导入 OpenAI 类

# 定义全局变量
CONFIG_FILE = 'config.yaml'
CHAPTER_SEPARATOR = '=================================================='
DEFAULT_INPUT_PATTERN = './道教/庄子-庄子-(先秦,道教,哲学).txt'  # 默认的书籍文件匹配模式
OUTPUT_FOLDER = './enhanced'   # 存放增强后内容的文件夹

def log(message):
    """
    打印日志信息，包含年月日时分秒。
    """
    current_time = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    print(f'[{current_time}] {message}')

def load_config(config_file):
    """
    从配置文件加载 API 客户端配置。
    """
    if not os.path.exists(config_file):
        log(f"配置文件 {config_file} 不存在，请创建配置文件并设置 API 信息。")
        sys.exit(1)
    with open(config_file, 'r', encoding='utf-8') as f:
        config = yaml.safe_load(f)
    return config

def initialize_client(config):
    """
    根据配置初始化客户端，支持 OpenAI 和其他兼容的 API。
    """
    api_key = config['api']['api_key']
    api_base = config['api'].get('api_base', '')
    os.environ['API_KEY'] = api_key  # 设置环境变量，供客户端使用
    client = OpenAI(
        api_key=api_key,
        base_url=api_base,
    ) if not api_base else OpenAI(api_key=api_key)
    model = config['api'].get('model', 'gpt-3.5-turbo')
    log(f"客户端已初始化，API 基础 URL: {api_base}, 使用模型: {model}")
    return client, model

def get_book_files(input_pattern):
    """
    获取符合指定模式的书籍文件列表。
    """
    file_list = glob.glob(input_pattern, recursive=True)
    return file_list

def confirm_books(file_list):
    """
    输出要增强的书籍列表，供用户确认。
    """
    log("即将增强以下书籍：")
    for idx, file_path in enumerate(file_list, 1):
        log(f"{idx}. {file_path}")
    confirmation = input("确认开始处理吗？(y/n): ")
    return confirmation.lower() == 'y'

def load_books(file_list):
    """
    从文件列表中加载书籍内容，返回书籍信息的列表。
    """
    books = []
    for file_path in file_list:
        if not os.path.exists(file_path):
            log(f"文件 {file_path} 不存在，跳过。")
            continue
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        # 提取书名和种类（假设文件名格式为 'category/bookname-author-(tags).txt'）
        match = re.match(r'(.+)/(.+?)-(.+?)(?:-\(.*\))?\.txt$', file_path)
        if match:
            category = os.path.basename(match.group(1))
            book_name = match.group(2)
            author = match.group(3)
        else:
            category = '未知类别'
            book_name = os.path.splitext(os.path.basename(file_path))[0]
            author = '佚名'
        books.append({
            'category': category,
            'book_name': book_name,
            'author': author,
            'content': content,
        })
    return books

def split_into_chapters(content):
    """
    使用分隔符将书籍内容分割成章节，返回章节列表。
    """
    chapters = content.split(CHAPTER_SEPARATOR)
    return [chapter.strip() for chapter in chapters if chapter.strip()]

def construct_prompt(chapter_content):
    """
    构建发送给 LLM 的提示词。
    """
    prompt = f"""请对以下文言文进行处理：

{chapter_content}

要求：
1. 将以上内容翻译成白话文，翻译时尽可能分成多个段落，以便于阅读。
2. 对于生僻难字，在字后加上拼音和声调。
3. 如果内容中包含典故，请进行解释说明，并以“典故解释”作为标题。
4. 汇总其中深刻有意义的句子，并以“深刻句子汇总”作为标题。
5. 给出章节的总结思想，字数为译文的十分之一，并以“章节总结”作为标题。

请按照以上要求生成内容，每个部分以对应的标题开头，内容之间用空行分隔。
"""
    return prompt

def call_llm_api(client, messages, model, max_retries=3, max_tokens=4096):
    """
    调用 LLM API，获取返回结果。
    """
    for attempt in range(max_retries):
        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=0.6,
                timeout=300,  # 设置超时时间为5分钟
            )
            assistant_message = response.choices[0].message
            result = assistant_message['content'].strip()
            # 打印返回的 response 信息
            log(f"收到 API 响应：{response}")
            return result
        except Exception as e:
            log(f"调用 API 出错：{e}")
            if attempt < max_retries - 1:
                wait_time = 5 * (attempt + 1)
                log(f"等待 {wait_time} 秒后重试...")
                time.sleep(wait_time)
            else:
                log("已达到最大重试次数，跳过该章节。")
                return None

def save_output(category, book_name, chapter_title, content):
    """
    将 LLM 返回的内容保存到指定路径。
    """
    output_dir = os.path.join(OUTPUT_FOLDER, category)
    os.makedirs(output_dir, exist_ok=True)
    # 处理章节标题中的非法字符
    chapter_title_sanitized = re.sub(r'[\/:*?"<>|]', '_', chapter_title)
    filename = f"{book_name}-{chapter_title_sanitized}.txt"
    file_path = os.path.join(output_dir, filename)
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    log(f"已保存到 {file_path}")

def process_books(books, client, model):
    """
    处理书籍列表，针对每个章节调用 LLM API 并保存结果。
    """
    for book in books:
        category = book['category']
        book_name = book['book_name']
        author = book['author']
        content = book['content']
        log(f"开始处理《{book_name}》 作者：{author}")
        chapters = split_into_chapters(content)
        for idx, chapter in enumerate(chapters):
            chapter_title = f"第{idx + 1}章"
            log(f"处理 {chapter_title} ...")

            # 构建 prompt
            prompt = construct_prompt(chapter)
            # 打印生成的 prompt 内容
            log(f"生成的提示词（prompt）：\n{prompt}")

            # 构建 messages
            messages = [
                {"role": "system", "content": "你是一个精通中国古典文学的助手。"},
                {"role": "user", "content": prompt},
            ]

            result = call_llm_api(client, messages, model)
            if result:
                save_output(category, book_name, chapter_title, result)
            else:
                log(f"跳过 {chapter_title} 的处理。")
            # 为了遵守 API 使用政策，添加延迟
            time.sleep(1)

def main():
    # 解析命令行参数
    parser = argparse.ArgumentParser(description='增强文言文书籍的阅读体验。')
    parser.add_argument('--input', type=str, default=DEFAULT_INPUT_PATTERN, help='书籍文件的输入模式，支持 glob 模式。')
    args = parser.parse_args()

    # 加载配置
    config = load_config(CONFIG_FILE)
    client, model = initialize_client(config)

    # 打印 client 的基本信息
    log(f"客户端信息：{client}")

    # 获取书籍文件列表
    file_list = get_book_files(args.input)
    if not file_list:
        log("未找到任何符合条件的书籍文件。")
        sys.exit(1)

    # 确认要处理的书籍
    if not confirm_books(file_list):
        log("已取消处理。")
        sys.exit(0)

    # 加载书籍
    books = load_books(file_list)
    # 处理书籍
    process_books(books, client, model)

if __name__ == '__main__':
    main()
