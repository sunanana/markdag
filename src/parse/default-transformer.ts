// 既定の変換器。markmap-lib の標準のプラグイン一式 (frontmatter、原文の行、チェックボックス、数式、コードの色付けなど) で変換する。
// markmap-lib を import するのはここだけにする。変換器を自分で渡す利用者の成果物に、既定の構成
// (ブラウザでは数式やコードの色付けの部品を外部から読み込む) が入り込まないようにするため。
import { Transformer } from 'markmap-lib';

let shared: Transformer | undefined;

// 作るのは、初めて使うときに 1 度だけ
export const defaultTransformer = (): Transformer => (shared ??= new Transformer());
