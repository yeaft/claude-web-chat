import os
import yaml
import argparse

# 读取YAML文件，显式指定utf-8编码
def load_yaml_config(file_path):
    with open(file_path, 'r', encoding='utf-8') as file:
        return yaml.safe_load(file)

# 读取指定文件内容
def read_file_content(file_path):
    with open(file_path, 'r', encoding='utf-8') as f:
        return f.read()

# 获取指定路径下的所有文件
def get_files_in_directory(file_path, file_suffix="", recursive=False, filename_pattern=""):
    file_list = []
    if recursive:
        for root, _, files in os.walk(file_path):
            for file in files:
                if (not file_suffix or file.endswith(file_suffix)) and (not filename_pattern or filename_pattern in file):
                    file_list.append(os.path.join(root, file))
    else:
        for file in os.listdir(file_path):
            if os.path.isfile(os.path.join(file_path, file)):
                if (not file_suffix or file.endswith(file_suffix)) and (not filename_pattern or filename_pattern in file):
                    file_list.append(os.path.join(file_path, file))
    return file_list

# 合并文件内容到参考部分
def merge_file_content(reference):
    merged_content = ""
    
    for ref in reference:
        description = ref.get("description", "")
        file_path = ref.get("file_path", "")
        file_suffix = ref.get("file_suffix", "")
        recursive = ref.get("recursive", False)
        filename_pattern = ref.get("filename_pattern", "")
        
        # 如果有description, 则添加到内容中
        if description:
            merged_content += f"{description}\n"
        
        # 如果指定了文件路径, 读取并合并文件内容
        if file_path:
            files = get_files_in_directory(file_path, file_suffix, recursive, filename_pattern)
            for file in files:
                # 使用 os.path.basename 只显示文件名
                file_name = os.path.basename(file)
                merged_content += f"File: {file_name}\n"
                merged_content += read_file_content(file)
                merged_content += "\n\n"  # 文件间隔

    return merged_content

# 生成最终的prompt
def generate_prompt(yaml_config, yaml_file_name):
    prompt = ""

    # 处理context
    context = yaml_config.get('context', '')
    if context:
        prompt += f"Context:\n\n{context}\n\n"

    # 处理requirements
    requirements = yaml_config.get('requirements', '')
    if requirements:
        prompt += f"Requirements:\n\n{requirements}\n\n"

    # 处理references
    references = yaml_config.get('reference', [])
    reference_content = merge_file_content(references)
    if reference_content:
        prompt += f"References:\n\n{reference_content}\n\n"

    # 处理summary
    summary = yaml_config.get('summary', '')
    if summary:
        prompt += f"Summary of tasks:\n\n{summary}\n"

    # 如果 prompt 有内容则保存
    if prompt:
        # 生成基于模板文件名的输出文件名
        base_file_name = os.path.splitext(os.path.basename(yaml_file_name))[0]
        output_file_name = f"{base_file_name}_prompt.txt"
        with open(output_file_name, "w", encoding="utf-8") as output_file:
            output_file.write(prompt)
        print(f"Prompt has been generated and saved to '{output_file_name}'.")
    else:
        print("No prompt content to generate.")

if __name__ == "__main__":
    # 解析命令行参数
    parser = argparse.ArgumentParser(description='Generate a prompt based on a YAML template.')
    parser.add_argument('yaml_file', type=str, help='Path to the YAML template file')
    
    args = parser.parse_args()
    
    # 加载YAML配置文件
    config = load_yaml_config(args.yaml_file)

    # 生成Prompt并保存，文件名基于模板文件
    generate_prompt(config, args.yaml_file)
