"""
TF-IDF vektörizer yardımcıları.

Amaç: Kelime TF-IDF + char n-gram TF-IDF'yi tek bir obje gibi kullanmak.
Bu sayede model eğitimi ve tahmin tarafı aynı vektörleştirmeyi paylaşır.
"""

from __future__ import annotations

import numpy as np
from scipy import sparse as sp
from sklearn.feature_extraction.text import TfidfVectorizer


class DualTfidfVectorizer:
    """
    Kelime + karakter n-gram TF-IDF birleşimi.

    - word: klasik kelime n-gram özellikleri
    - char_wb: kelime içi karakter n-gramları (Türkçe ekler / yazım varyasyonları / spam kalıpları için güçlü)
    """

    def __init__(
        self,
        word_max_features: int = 12000,
        word_ngram_range=(1, 2),
        char_max_features: int = 8000,
        char_ngram_range=(3, 5),
        min_df=2,
        max_df=0.95,
        sublinear_tf=True,
    ):
        self.word_vectorizer = TfidfVectorizer(
            max_features=word_max_features,
            ngram_range=word_ngram_range,
            min_df=min_df,
            max_df=max_df,
            sublinear_tf=sublinear_tf,
        )
        self.char_vectorizer = TfidfVectorizer(
            analyzer="char_wb",
            max_features=char_max_features,
            ngram_range=char_ngram_range,
            min_df=min_df,
            max_df=max_df,
            sublinear_tf=sublinear_tf,
        )

    def fit(self, X, y=None):
        self.word_vectorizer.fit(X)
        self.char_vectorizer.fit(X)
        return self

    def transform(self, X):
        Xw = self.word_vectorizer.transform(X)
        Xc = self.char_vectorizer.transform(X)
        return sp.hstack([Xw, Xc], format="csr")

    def fit_transform(self, X, y=None):
        Xw = self.word_vectorizer.fit_transform(X)
        Xc = self.char_vectorizer.fit_transform(X)
        return sp.hstack([Xw, Xc], format="csr")

    def get_feature_names_out(self):
        w = self.word_vectorizer.get_feature_names_out()
        c = self.char_vectorizer.get_feature_names_out()
        # İsim çakışmasını önlemek için prefix ekle
        w = np.array([f"w:{t}" for t in w], dtype=object)
        c = np.array([f"c:{t}" for t in c], dtype=object)
        return np.concatenate([w, c])


