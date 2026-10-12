class AppError(Exception):
    def __init__(self, category: str, message: str, status: int = 400):
        self.category, self.message, self.status = category, message, status
        super().__init__(message)
