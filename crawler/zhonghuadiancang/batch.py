import os
import re
import sys
import time
import yaml
import glob
import argparse
import datetime
import json
import pymongo  # 用于连接 MongoDB 数据库

# 定义全局变量
CONFIG_FILE = 'config.yaml'
CHAPTER_SEPARATOR = '=================================================='
DEFAULT_INPUT_PATTERN = './道教/庄子-庄子-(先秦,道教,哲学).txt'  # 默认的书籍文件匹配模式
OUTPUT_FOLDER = './jsonl_output'   # 存放生成的 JSONL 文件的文件夹
ENHANCED_FOLDER = './enhanced'     # 存放处理过的 JSONL 文件的文件夹

def log(message):
    """
    打印日志信息，包含年月日时分秒。
    """
    current_time = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    print(f'[{current_time}] {message}')

def load_config(config_file):
    """
    从配置文件加载配置信息，包括数据库配置。
    """
    if not os.path.exists(config_file):
        log(f"配置文件 {config_file} 不存在，请创建配置文件并设置配置信息。")
        sys.exit(1)
    with open(config_file, 'r', encoding='utf-8') as f:
        config = yaml.safe_load(f)
    return config

def get_book_files(input_pattern):
    """
    获取符合指定模式的书籍文件列表。
    """
    file_list = glob.glob(input_pattern, recursive=True)
    return file_list

def confirm_books(file_list):
    """
    输出要处理的书籍列表，供用户确认。
    """
    log("即将处理以下书籍：")
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
        # 提取书名、作者、类别和标签（假设文件名格式为 'category/bookname-author-(tags).txt'）
        match = re.match(r'(.+)/(.+?)-(.+?)(?:-\((.*?)\))?\.txt$', file_path)
        if match:
            category = os.path.basename(match.group(1))
            book_name = match.group(2)
            author = match.group(3)
            tags = match.group(4).split(',') if match.group(4) else []
        else:
            category = 'Unknown'
            book_name = os.path.splitext(os.path.basename(file_path))[0]
            author = 'Unknown'
            tags = []
        books.append({
            'category': category,
            'book_name': book_name,
            'author': author,
            'tags': tags,
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
1. 将以上内容翻译成白话文，翻译时尽可能分成多个段落，以便于阅读，并以“白话文翻译”作为标题。
2. 对于生僻难字，在字后加上拼音和声调。
3. 如果内容中包含典故，请进行解释说明，并以“典故解释”作为标题。
4. 汇总其中深刻有意义的句子，并以“深刻句子汇总”作为标题。
5. 给出章节的总结思想，字数为译文的十分之一，并以“章节总结”作为标题。

请按照以上要求生成内容，每个部分以对应的标题开头，内容之间用空行分隔。
"""
    return prompt

def generate_jsonl(books):
    """
    为每本书生成一个 JSONL 文件，供 Azure OpenAI Batch 服务使用。
    """
    for book in books:
        category = book['category']
        book_name = book['book_name']
        author = book['author']
        tags = book['tags']
        content = book['content']
        log(f"开始处理《{book_name}》 作者：{author}")

        chapters = split_into_chapters(content)
        jsonl_lines = []

        for idx, chapter in enumerate(chapters):
            chapter_title = f"第{idx + 1}章"
            log(f"处理 {chapter_title} ...")

            # 构建 prompt
            prompt = construct_prompt(chapter)
            log(f"生成的提示词（prompt）：\n{prompt}")

            # 构建 messages
            messages = [
                {"role": "system", "content": "你是一个精通中国古典文学的助手。"},
                {"role": "user", "content": prompt},
            ]

            # 创建 JSONL 条目
            custom_id = f"{book_name}-Chapter{idx + 1}"
            jsonl_entry = {
                "custom_id": custom_id,
                "method": "POST",
                "url": "/chat/completions",
                "body": {
                    "model": "REPLACE-WITH-MODEL-DEPLOYMENT-NAME",  # 您需要在上传时替换为实际的部署名称
                    "messages": messages,
                    "temperature": 0.6,
                    "max_tokens": 4096
                }
            }

            # 将 JSONL 条目转换为字符串，并添加到列表中
            jsonl_line = json.dumps(jsonl_entry, ensure_ascii=False)
            jsonl_lines.append(jsonl_line)

        # 保存 JSONL 文件
        output_dir = os.path.join(OUTPUT_FOLDER, category)
        os.makedirs(output_dir, exist_ok=True)
        filename = f"{book_name}.jsonl"
        file_path = os.path.join(output_dir, filename)
        with open(file_path, 'w', encoding='utf-8') as f:
            for line in jsonl_lines:
                f.write(line + '\n')
        log(f"已生成 JSONL 文件：{file_path}")

def load_from_jsonl(books, mongo_config):
    """
    从处理过的 JSONL 文件中加载数据，解析内容，并存储到 MongoDB 中。
    """
    # 连接 MongoDB
    client = pymongo.MongoClient(mongo_config['host'], mongo_config['port'])
    db = client[mongo_config['database']]
    collection = db[mongo_config['collection']]
    log(f"已连接到 MongoDB 数据库：{mongo_config['database']}，集合：{mongo_config['collection']}")

    for book in books:
        category = book['category']
        book_name = book['book_name']
        author = book['author']
        tags = book['tags']
        content = book['content']
        log(f"开始加载《{book_name}》 作者：{author}")

        # 加载章节原文
        chapters_content = split_into_chapters(content)
        chapter_count = len(chapters_content)

        # 加载处理过的 JSONL 文件
        jsonl_file = os.path.join(ENHANCED_FOLDER, category, f"{book_name}.jsonl")
        if not os.path.exists(jsonl_file):
            log(f"处理过的 JSONL 文件 {jsonl_file} 不存在，跳过该书。")
            continue

        # 读取并解析 JSONL 文件
        with open(jsonl_file, 'r', encoding='utf-8') as f:
            jsonl_lines = f.readlines()

        # 将每一行解析为字典，存储在列表中
        jsonl_data = []
        for line in jsonl_lines:
            data = json.loads(line)
            jsonl_data.append(data)

        # 定义一个函数，从 custom_id 中提取章节编号
        def extract_chapter_number(custom_id):
            match = re.search(r'(\d+)', custom_id)
            if match:
                return int(match.group(1))
            else:
                return float('inf')  # 如果未找到章节编号，将其放在最后

        # 对 jsonl_data 列表按照章节编号排序
        jsonl_data.sort(key=lambda x: extract_chapter_number(x.get('custom_id', '')))

        # 遍历排序后的 jsonl_data
        for data in jsonl_data:
            custom_id = data.get('custom_id', '')
            response = data.get('response', {})
            error = data.get('error', None)

            if error:
                log(f"章节 {custom_id} 处理出错，跳过。")
                continue

            # 从 custom_id 中提取章节编号
            chapter_match = re.search(r'(\d+)', custom_id)
            if chapter_match:
                chapter_number = int(chapter_match.group(1))
            else:
                log(f"无法从 custom_id '{custom_id}' 中提取章节编号，跳过。")
                continue

            # 从 response 中提取 assistant 的 content
            try:
                assistant_message = response['body']['choices'][0]['message']
                content_text = assistant_message['content']
            except Exception as e:
                log(f"解析响应内容出错：{e}")
                continue

            # 解析 content_text，提取四个部分
            parsed_content = parse_content(content_text)

            pc = parsed_content.get('plain_translation', '')
            if len(pc) < 10:
                log(f"原文 {chapters_content[chapter_number - 1]}")
                log(f"解析内容：{content_text}")
                log("=========================================")

            # 组装章节信息
            chapter_info = {
                'name': book_name,
                'author': author,
                'categories': [category],
                'tags': tags,
                'chapter_count': chapter_count,
                'chapter': chapter_number,
                'chapter_title': f"第{chapter_number}章",
                'original_text': chapters_content[chapter_number - 1],
                'plain_translation': parsed_content.get('plain_translation', ''),
                'allusion_explanation': parsed_content.get('allusion_explanation', ''),
                'profound_sentences': parsed_content.get('profound_sentences', ''),
                'summary': parsed_content.get('summary', ''),
            }

            # 将章节信息插入到 MongoDB 中
            collection.replace_one(
                {'name': book_name, 'author': author, 'chapter': chapter_number},
                chapter_info,
                upsert=True
            )
            log(f"已将《{book_name}》第 {chapter_number} 章保存到数据库。")

    # 关闭 MongoDB 连接
    client.close()
    log("已关闭 MongoDB 连接。")

def parse_content(content_text):
    """
    解析 assistant 的内容，提取四个部分：
    - 白话文翻译：plain_translation
    - 典故解释：allusion_explanation
    - 深刻句子汇总：profound_sentences
    - 章节总结：summary
    """
    sections = {
        'plain_translation': '',
        'allusion_explanation': '',
        'profound_sentences': '',
        'summary': ''
    }

    # 定义标题的可能变体
    title_variants = {
        'plain_translation': ['白话文翻译', '翻译成白话文', '白话翻译', '白话译文', '翻译'],
        'allusion_explanation': ['典故解释', '典故的解释', '典故注释'],
        'profound_sentences': ['深刻句子汇总', '深刻的句子汇总', '深刻句子', '经典句子'],
        'summary': ['章节总结', '本章总结', '章节的总结', '总结']
    }

    # 找到每个标题在文本中的位置
    content_text = content_text.strip()
    positions = []

    for section_key, variants in title_variants.items():
        for variant in variants:
            pos = content_text.find(variant)
            if pos != -1:
                positions.append((pos, variant, section_key))
                break  # 找到第一个匹配的标题后，退出当前循环

    # 如果没有找到任何一个标题，返回空的 sections
    if not positions:
        return sections

    # 根据标题的位置，按顺序提取内容
    positions.sort(key=lambda x: x[0])  # 按位置排序

    for i, (start_pos, title, section_key) in enumerate(positions):
        end_pos = len(content_text)
        if i + 1 < len(positions):
            end_pos = positions[i + 1][0]

        # 提取标题对应的内容，并去除标题行
        section_content = content_text[start_pos:end_pos].strip()
        # 去除标题行
        section_content = section_content[len(title):].strip()
        # 移除可能存在的章节标题，例如 '**第 3 章 养生主第三**'
        section_content = re.sub(r'^\*\*.*?\*\*', '', section_content, flags=re.MULTILINE).strip()
        # 替换 '###' 为空格
        section_content = section_content.replace('###', '').strip()

        # 将内容存入对应的字段
        sections[section_key] = section_content

    return sections


def main():
    # 解析命令行参数
    parser = argparse.ArgumentParser(description='生成 JSONL 文件或加载处理结果到 MongoDB。')
    parser.add_argument('--input', type=str, default=DEFAULT_INPUT_PATTERN, help='书籍文件的输入模式，支持 glob 模式。')
    parser.add_argument('--action', type=str, choices=['generate', 'load'], default='generate', help='操作类型：generate 生成 JSONL 文件，load 加载处理结果到 MongoDB。')
    args = parser.parse_args()

    # 加载配置
    config = load_config(CONFIG_FILE)

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

    if args.action == 'generate':
        # 生成 JSONL 文件
        generate_jsonl(books)
    elif args.action == 'load':
        # 从处理结果中加载数据到 MongoDB
        mongo_config = config['mongodb']
        load_from_jsonl(books, mongo_config)
    else:
        log(f"未知的操作类型：{args.action}")

if __name__ == '__main__':
    main()
