// e2e の土台。ライブラリの 2 つの入口と、利用者が自分で組む変換器を、テストから page.evaluate で使えるように window に置く。
import { Transformer } from 'markmap-lib/no-plugins';
import { pluginCheckbox, pluginFrontmatter, pluginSourceLines } from 'markmap-lib/plugins';
import * as core from '../src/core';
import * as markdag from '../src/index';

export interface Harness {
    markdag: typeof markdag;
    core: typeof core;
    // 公開の文書に載せている、プラグインを必要なものだけにした変換器
    createTransformer: () => Transformer;
}

(window as unknown as { harness: Harness }).harness = {
    markdag,
    core,
    createTransformer: () => new Transformer([pluginFrontmatter, pluginCheckbox, pluginSourceLines]),
};
